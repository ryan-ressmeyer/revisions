// The "Changes & history" panel: the commit graph, the uncommitted changes,
// and every way of sending changes back to GitHub, in plain words.
import {
	type CSSProperties,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ApiError, type RepoId } from "../api/client";
import {
	type Commit,
	type CommitDetail,
	createPull,
	type DeletePreview,
	type DiscardPreview,
	type FileStatus,
	type FinishedBranch,
	type GitStatus,
	gitCheckout,
	gitCommit,
	gitCommitDetail,
	gitCreateBranch,
	gitDeleteBranch,
	gitDeletePreview,
	gitDiff,
	gitDiscard,
	gitDiscardPreview,
	gitForcePush,
	gitForcePushPreview,
	gitLog,
	gitMergeAbort,
	gitPull,
	gitPush,
	gitStatus,
	gitViewVersion,
	type PullRequest,
	type PullStep,
} from "../api/git";
import type { RepoState } from "../api/repo";
import { layoutGraph } from "../core/graph/graph";
import { branchChoices, type RefChip, refChips } from "../core/graph/refs";
import { DiffView } from "./Diff";
import { explain, failure, isCode } from "./errors";

export const statusWords: Record<FileStatus["status"], string> = {
	modified: "changed",
	added: "added",
	deleted: "deleted",
	renamed: "renamed",
	untracked: "new",
	conflicted: "has conflicts",
};

const MERGE_MESSAGE = "Combine my changes with the latest from GitHub";
export const UNSAVED =
	"Your latest edits could not be saved, so nothing was done. See the message above the editor.";
/** Why a collaborator without push permission cannot share. */
export const WRITE_ACCESS =
	"Sharing needs write access, which the author grants on GitHub.";

interface Problem {
	text: string;
	reconnect?: boolean;
	details?: string;
	files?: string[];
}

/** The sentence, Git's details, and the files an error names. */
export function problemOf(error: unknown): Problem {
	const files =
		error instanceof ApiError && Array.isArray(error.extra.files)
			? (error.extra.files as (string | FileStatus)[]).map((f) =>
					typeof f === "string" ? f : `${f.path} (${statusWords[f.status]})`,
				)
			: undefined;
	return {
		...failure(error),
		files,
		reconnect: isCode(error, "auth_required"),
	};
}

interface Log {
	commits: Commit[];
	pulls: PullRequest[];
}

type DialogName = "branch" | "pull" | "force" | "discard";

/** The page's last check for changes on GitHub. */
export interface GitHubCheck {
	/** When a check last reached GitHub, ISO 8601; null before the first. */
	reached: string | null;
	/** The latest check could not reach GitHub. */
	unreachable: boolean;
}

/** "" selects the uncommitted changes. */
type Selection = string;

export function GitPanel({
	id,
	state,
	github,
	flush,
	onChanged,
	onOpenSource,
	onAuthLost,
	onClose,
}: {
	id: RepoId;
	/** The 2-second state poll; the panel refreshes when it changes. */
	state: RepoState | null;
	/** The page checks GitHub; the panel refreshes after each check that reached it. */
	github: GitHubCheck;
	/** Saves the open file. False when that failed. */
	flush: () => Promise<boolean>;
	/** Called after anything that may have changed files or the checkout. */
	onChanged: () => void;
	/** Opens a file in the editor in Source mode. */
	onOpenSource: (path: string) => void;
	onAuthLost: () => void;
	onClose: () => void;
}) {
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [log, setLog] = useState<Log | null>(null);
	const [loadFailure, setLoadFailure] = useState("");
	const [selected, setSelected] = useState<Selection | null>(null);
	const [busy, setBusy] = useState("");
	const [problem, setProblem] = useState<Problem | null>(null);
	const [offer, setOffer] = useState<"get-latest" | "send" | null>(null);
	const [done, setDone] = useState("");
	const [dialog, setDialog] = useState<DialogName | null>(null);
	const [unclean, setUnclean] = useState<Unclean | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);

	const refresh = useCallback(async () => {
		try {
			const [s, l] = await Promise.all([gitStatus(id), gitLog(id)]);
			setStatus(s);
			setLog(l);
			setLoadFailure("");
		} catch (error) {
			setLoadFailure(failure(error).text);
		}
	}, [id]);

	useEffect(() => {
		heading.current?.focus();
	}, []);

	const headKey = state ? `${state.git.head} ${state.git.branch}` : "";
	const filesKey = state
		? `${state.git.dirty} ${Object.values(state.hashes).join()}`
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the checkout moves or GitHub was checked
	useEffect(() => {
		refresh();
	}, [refresh, headKey, github.reached]);
	useEffect(() => {
		if (filesKey) gitStatus(id).then(setStatus, () => {});
	}, [id, filesKey]);

	useEffect(() => {
		const changed = () => {
			// Do not reuse a destructive preview after changing accounts.
			setDialog((d) => (d === "force" || d === "discard" ? null : d));
			void refresh();
		};
		window.addEventListener("revisions:auth-changed", changed);
		return () => window.removeEventListener("revisions:auth-changed", changed);
	}, [refresh]);

	const after = useCallback(() => {
		refresh();
		onChanged();
	}, [refresh, onChanged]);

	const report = (error: unknown) => {
		if (isCode(error, "auth_required")) onAuthLost();
		setProblem(problemOf(error));
		setOffer(
			isCode(error, "rejected")
				? "get-latest"
				: isCode(error, "no_upstream") || isCode(error, "upstream_gone")
					? "send"
					: null,
		);
	};

	/** Saves the open file, runs `action`, and shows how it went. */
	const act = async (
		name: string,
		action: () => Promise<GitStatus>,
		success: (s: GitStatus) => string,
	): Promise<boolean> => {
		setProblem(null);
		setOffer(null);
		setDone("");
		if (!(await flush())) {
			setProblem({ text: UNSAVED });
			return false;
		}
		setBusy(name);
		try {
			const s = await action();
			setStatus(s);
			setDone(success(s));
			return true;
		} catch (error) {
			if (error instanceof Unclean) setUnclean(error);
			else report(error);
			return false;
		} finally {
			setBusy("");
			after();
		}
	};
	/** act for a move: uncommitted changes bring up the move prompt. */
	const go = (name: string, move: Move<GitStatus>) =>
		act(
			name,
			() => runMove(id, move),
			(s) => move.done?.(s) ?? "",
		);

	const getLatest = () =>
		go("pull", {
			label: `Get latest for branch ${status?.branch}`,
			run: () => gitPull(id),
			done: (s) => (s.merging ? "" : "Your copy is up to date with GitHub."),
		});
	const send = () =>
		act(
			"push",
			() => gitPush(id),
			() => "Sent. GitHub now has your commits.",
		);
	const commit = async (message: string) => {
		const ok = await act(
			"commit",
			() => gitCommit(id, message),
			(s) =>
				s.unsent > 0 && s.permissions.push
					? "Committed on this computer. Send it when you want your co-authors to see it."
					: "Committed on this computer.",
		);
		if (ok) setSelected(null);
		return ok;
	};
	const createBranch = (name: string) =>
		act(
			"branch",
			() => gitCreateBranch(id, name),
			(s) => `You are now on the new branch ${s.branch}.`,
		);
	const viewVersion = (sha: string) => {
		const c = log?.commits.find((c) => c.sha === sha);
		return go("view", {
			label: c
				? `View the version of ${longDate(c.date)}: ${c.subject}`
				: `View version ${sha.slice(0, 7)}`,
			run: () => gitViewVersion(id, sha),
			done: () =>
				"The editor now shows this version, read-only. Click Read-only: earlier version, at the top, to go back or start a branch.",
		});
	};
	const abortMerge = () =>
		act(
			"abort",
			() => gitMergeAbort(id),
			() => "The merge was undone. Your copy is as it was before Get latest.",
		);
	/** Removes a finished branch from this computer, never from GitHub. The
	 * current one is left for the default branch first. */
	const removeFinished = (f: FinishedBranch) => {
		const target = f.name === status?.branch ? status.defaultBranch : null;
		const gone = `${f.name} was removed from this computer. GitHub was not changed.`;
		return act(
			"remove",
			async () => {
				if (!target) return gitDeleteBranch(id, f.name, f.fingerprint);
				await gitCheckout(id, target);
				try {
					return await gitDeleteBranch(id, f.name, f.fingerprint);
				} catch (error) {
					throw new ApiError(
						0,
						"not_removed",
						`You are now on branch ${target}, but branch ${f.name} was not removed from this computer. ${explain(error)}`,
						{},
					);
				}
			},
			() =>
				target
					? `You are now on branch ${target}, and branch ${gone}`
					: `Branch ${gone}`,
		);
	};
	const openDialog = async (name: DialogName) => {
		setProblem(null);
		setDone("");
		if ((name === "force" || name === "discard") && !(await flush())) {
			setProblem({ text: UNSAVED });
			return;
		}
		setDialog(name);
	};
	const closeDialog = (message = "") => {
		setDialog(null);
		if (message) {
			setDone(message);
			setSelected(null);
			after();
		}
	};

	const canPush = status?.permissions.push ?? false;
	const detached = status !== null && status.branch === null;
	const dirty = (status?.files.length ?? 0) > 0;
	const shown = selected ?? (dirty ? "" : (status?.head ?? null));

	return (
		<section className="git-panel" aria-label="Changes & history">
			<header className="git-head">
				<div>
					<h2 ref={heading} tabIndex={-1}>
						Changes &amp; history
					</h2>
					{status && <p className="git-where muted">{where(status)}</p>}
					{github.unreachable ? (
						<p className="git-where">
							{github.reached ? (
								<>
									GitHub could not be reached. It was last reached{" "}
									<When iso={github.reached} />, so your copy may be out of
									date.
								</>
							) : (
								"GitHub could not be reached, so your copy may be out of date."
							)}
						</p>
					) : (
						github.reached && (
							<p className="git-where muted">
								Checked GitHub <When iso={github.reached} />
							</p>
						)
					)}
				</div>
				<button
					type="button"
					className="quiet"
					onClick={onClose}
					aria-label="Close changes and history"
					title="Close"
				>
					✕
				</button>
			</header>

			<div className="git-actions">
				<button
					type="button"
					onClick={getLatest}
					disabled={!status || !!busy || detached}
					title="Get your co-authors' changes from GitHub and combine them with yours (git pull)"
				>
					{busy === "pull" ? <Spinner /> : <Arrow down />}Get latest
					{(status?.behind ?? 0) > 0 && (
						<span className="count" aria-hidden="true">
							{status?.behind}
						</span>
					)}
				</button>
				{canPush && (
					<button
						type="button"
						onClick={send}
						disabled={!!busy || detached}
						title="Send your commits to GitHub (git push)"
					>
						{busy === "push" ? <Spinner /> : <Arrow />}Send
						{(status?.unsent ?? 0) > 0 && (
							<span className="count" aria-hidden="true">
								{status?.unsent}
							</span>
						)}
					</button>
				)}
				<button
					type="button"
					onClick={() => openDialog("branch")}
					disabled={!status || !!busy}
					title="Start a separate line of work, or switch to another one (git branch, git switch)"
				>
					Branch…
				</button>
				{canPush && (
					<button
						type="button"
						onClick={() => openDialog("pull")}
						disabled={!!busy || detached}
						title="Ask the author to review your branch and take it in (GitHub pull request)"
					>
						Pull request…
					</button>
				)}
				<span className="spacer" />
				{canPush && (
					<button
						type="button"
						className="quiet danger"
						onClick={() => openDialog("force")}
						disabled={!!busy || detached}
						title="Replace the branch on GitHub with yours, erasing commits only GitHub has (git push --force-with-lease)"
					>
						Force-push…
					</button>
				)}
			</div>

			{status && !canPush && (
				<p className="git-note">
					Your GitHub account can read this manuscript but not change it, so
					Send and pull requests are not offered. {WRITE_ACCESS} You can still
					commit on this computer.
				</p>
			)}
			{status && status.finished.length > 0 && (
				<ul className="finished-list" aria-label="Finished branches">
					{status.finished.map((f) => {
						const current = f.name === status.branch;
						return (
							<li key={f.name} className="git-note">
								<span>
									Branch <b>{f.name}</b> is finished. Its GitHub branch was
									removed, and everything on it is kept on GitHub
									{f.pull > 0 ? `, in pull request #${f.pull}` : ""}. Removing
									it here changes nothing on GitHub.
									{current &&
										(status.defaultBranch
											? ` You are on it, so Remove first switches to branch ${status.defaultBranch}.`
											: " Switch to another branch to remove it.")}
								</span>
								{!(current && !status.defaultBranch) && (
									<button
										type="button"
										disabled={!!busy}
										onClick={() => removeFinished(f)}
										aria-label={`Remove branch ${f.name}`}
									>
										{busy === "remove" && <Spinner />}Remove
									</button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{status?.merging && (
				<MergeBanner
					conflicts={status.conflicts}
					busy={!!busy}
					onOpen={onOpenSource}
					onAbort={abortMerge}
				/>
			)}
			{problem && (
				<ProblemBox problem={problem}>
					{offer === "get-latest" && (
						<>
							<button type="button" className="primary" onClick={getLatest}>
								Get latest
							</button>
							{canPush && (
								<span className="muted">
									Only if you are sure your version should replace theirs:{" "}
									<button
										type="button"
										className="link"
										onClick={() => openDialog("force")}
									>
										Force-push…
									</button>
								</span>
							)}
						</>
					)}
					{offer === "send" && canPush && (
						<button type="button" className="primary" onClick={send}>
							Send
						</button>
					)}
				</ProblemBox>
			)}
			<p className="git-done" role="status">
				{done}
			</p>
			{loadFailure && (
				<p role="alert" className="alert">
					{loadFailure}
				</p>
			)}

			<div className="git-body">
				{status && log ? (
					<Graph
						log={log}
						status={status}
						selected={shown}
						onSelect={setSelected}
					/>
				) : (
					<p className="muted git-loading">
						<Spinner /> Reading the history…
					</p>
				)}
				<div className="git-detail">
					{status && shown === "" ? (
						<ChangesView
							id={id}
							status={status}
							filesKey={filesKey}
							busy={!!busy}
							onCommit={commit}
							onCreateBranch={createBranch}
							onDiscard={() => openDialog("discard")}
						/>
					) : shown ? (
						<CommitView
							id={id}
							sha={shown}
							busy={!!busy}
							onView={
								shown === status?.head ? undefined : () => viewVersion(shown)
							}
						/>
					) : null}
				</div>
			</div>

			{dialog === "branch" && status && log && (
				<BranchDialog
					id={id}
					current={status.branch}
					commits={log.commits}
					flush={flush}
					onAuthLost={onAuthLost}
					onDone={(s) => {
						setStatus(s);
						closeDialog(`You are now on branch ${s.branch}.`);
					}}
					onDeleted={(s, name) => {
						setStatus(s);
						closeDialog(
							`Branch ${name} was deleted from this computer. GitHub was not changed.`,
						);
					}}
					onUnclean={(u) => {
						setDialog(null);
						setUnclean(u);
					}}
					onClose={() => closeDialog()}
				/>
			)}
			{unclean && (
				<MovePrompt
					id={id}
					unclean={unclean}
					onAuthLost={onAuthLost}
					onMoved={(message) => {
						setUnclean(null);
						closeDialog(message);
					}}
					onClose={() => {
						setUnclean(null);
						after();
					}}
				/>
			)}
			{dialog === "pull" && status && (
				<PullDialog
					id={id}
					branch={status.branch}
					defaultBranch={status.defaultBranch}
					defaultTitle={
						log?.commits.find((c) => c.sha === status.head)?.subject ?? ""
					}
					flush={flush}
					after={after}
					onAuthLost={onAuthLost}
					onClose={() => closeDialog()}
				/>
			)}
			{dialog === "force" && status?.branch && (
				<ForcePushDialog
					id={id}
					branch={status.branch}
					onAuthLost={onAuthLost}
					onSent={() =>
						closeDialog("Sent. The branch on GitHub now matches your copy.")
					}
					onSendInstead={() => {
						closeDialog();
						send();
					}}
					onClose={() => closeDialog()}
				/>
			)}
			{dialog === "discard" && status && (
				<DiscardDialog
					id={id}
					merging={status.merging}
					onAuthLost={onAuthLost}
					onDiscarded={() => closeDialog("Your changes were discarded.")}
					onClose={() => closeDialog()}
				/>
			)}
		</section>
	);
}

/** One line on where this copy stands against GitHub. */
function where(s: GitStatus): string {
	if (s.branch === null)
		return `A snapshot of version ${s.head.slice(0, 7)}, not on a branch`;
	if (s.upstreamGone)
		return `On branch ${s.branch}, which was removed from GitHub. Your copy still has it`;
	if (s.upstream === null)
		return `On branch ${s.branch}, which is only on this computer so far`;
	const parts = [`On branch ${s.branch}`];
	if (s.unsent > 0)
		parts.push(`${s.unsent} commit${s.unsent === 1 ? "" : "s"} to send`);
	if (s.behind > 0)
		parts.push(
			`${s.behind} commit${s.behind === 1 ? "" : "s"} waiting on GitHub`,
		);
	if (s.ahead === 0 && s.behind === 0) parts.push("in sync with GitHub");
	return parts.join(" · ");
}

/** A date and time, for people. */
export const longDate = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		dateStyle: "long",
		timeStyle: "short",
	});

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

function Arrow({ down = false }: { down?: boolean }) {
	return (
		<svg
			className="icon"
			viewBox="0 0 16 16"
			aria-hidden="true"
			style={down ? { transform: "rotate(180deg)" } : undefined}
		>
			<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
		</svg>
	);
}

/** Marks a branch that is on GitHub. */
const Cloud = () => (
	<svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
		<path d="M4.5 12.5h7a3 3 0 0 0 .3-6A4 4 0 0 0 4 7.2a2.7 2.7 0 0 0 .5 5.3z" />
	</svg>
);

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["year", 31_536_000],
	["month", 2_592_000],
	["week", 604_800],
	["day", 86_400],
	["hour", 3_600],
	["minute", 60],
];

export function When({ iso }: { iso: string }) {
	const seconds = (Date.parse(iso) - Date.now()) / 1000;
	const unit = UNITS.find(([, n]) => Math.abs(seconds) >= n);
	return (
		<time dateTime={iso} title={new Date(iso).toLocaleString()}>
			{unit ? rtf.format(Math.round(seconds / unit[1]), unit[0]) : "just now"}
		</time>
	);
}

export function ProblemBox({
	problem,
	children,
}: {
	problem: Problem;
	children?: ReactNode;
}) {
	return (
		<div role="alert" className="alert git-problem">
			<p>{problem.text}</p>
			{problem.files && problem.files.length > 0 && (
				<ul>
					{problem.files.map((f) => (
						<li key={f}>{f}</li>
					))}
				</ul>
			)}
			{problem.details && (
				<details>
					<summary>Details from Git</summary>
					<pre>{problem.details}</pre>
				</details>
			)}
			{problem.reconnect && (
				<button
					type="button"
					onClick={() => window.dispatchEvent(new Event("revisions:reconnect"))}
				>
					Reconnect GitHub
				</button>
			)}
			{children && <div className="row">{children}</div>}
		</div>
	);
}

function MergeBanner({
	conflicts,
	busy,
	onOpen,
	onAbort,
}: {
	conflicts: string[];
	busy: boolean;
	onOpen: (path: string) => void;
	onAbort: () => void;
}) {
	return (
		<div role="alert" className="banner warn git-merge">
			{conflicts.length > 0 ? (
				<>
					<p>
						<b>Your changes and the latest from GitHub change the same lines</b>{" "}
						(a merge conflict). Open each file below. In the editor, keep the
						text you want and delete the marker lines that start with{" "}
						<code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>, <code>=======</code> and{" "}
						<code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code>. Then commit to finish.
					</p>
					<ul className="row conflict-files" aria-label="Files with conflicts">
						{conflicts.map((path) => (
							<li key={path}>
								<button type="button" onClick={() => onOpen(path)}>
									{path}
								</button>
							</li>
						))}
					</ul>
				</>
			) : (
				<p>
					<b>Every conflict is resolved.</b> Commit to finish combining your
					changes with the latest from GitHub.
				</p>
			)}
			<button
				type="button"
				className="quiet"
				onClick={onAbort}
				disabled={busy}
				title="Go back to how your copy was before Get latest (git merge --abort)"
			>
				Undo this merge
			</button>
		</div>
	);
}

// Graph geometry, in CSS pixels.
const ROW = 34;
const LANE = 14;
const PAD = 10;
const x = (lane: number) => PAD / 2 + lane * LANE + LANE / 2;
const y = (row: number) => row * ROW + ROW / 2;

function edgePath(from: number, to: number, row: number): string {
	const [x1, y1, x2, y2] = [x(from), y(row), x(to), y(row + 1)];
	if (x1 === x2) return `M${x1} ${y1}V${y2}`;
	return `M${x1} ${y1}C${x1} ${y1 + ROW * 0.6} ${x2} ${y2 - ROW * 0.6} ${x2} ${y2}`;
}

function chipTitle(chip: RefChip): string {
	const here = chip.current ? " You are on this branch." : "";
	if (chip.where === "both")
		return `Branch ${chip.name}: in sync with GitHub.${here}`;
	if (chip.where === "local")
		return `Branch ${chip.name} on this computer. GitHub's copy is elsewhere or missing.${here}`;
	return `Branch ${chip.name} on GitHub (origin/${chip.name}).`;
}

function Graph({
	log,
	status,
	selected,
	onSelect,
}: {
	log: Log;
	status: GitStatus;
	selected: Selection | null;
	onSelect: (selection: Selection) => void;
}) {
	const dirty = status.files.length > 0 && status.head !== "";
	const layout = useMemo(
		() => layoutGraph(log.commits, dirty ? { uncommittedOn: status.head } : {}),
		[log.commits, dirty, status.head],
	);
	const bySha = useMemo(
		() => new Map(log.commits.map((c) => [c.sha, c])),
		[log.commits],
	);
	const width = Math.max(1, layout.width) * LANE + PAD;

	// Up and Down move between rows, so the list is one tab stop away.
	const move = (event: KeyboardEvent<HTMLOListElement>) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const rows = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>(
				".graph-select",
			),
		];
		const at = rows.indexOf(document.activeElement as HTMLButtonElement);
		const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
		if (next) {
			event.preventDefault();
			next.focus();
		}
	};

	if (log.commits.length === 0)
		return <p className="muted git-loading">Nothing has been committed yet.</p>;

	return (
		<div className="graph-scroll">
			<div
				className="graph"
				style={{ "--graph-width": `${width}px` } as CSSProperties}
			>
				<svg
					className="graph-lines"
					width={width}
					height={layout.rows.length * ROW}
					aria-hidden="true"
				>
					{layout.rows.flatMap((row, i) =>
						row.edges.map((edge, k) => (
							<path
								// biome-ignore lint/suspicious/noArrayIndexKey: geometry is redrawn whole
								key={`${i}-${k}`}
								className={`lane-${edge.color % 8}`}
								d={edgePath(edge.from, edge.to, i)}
							/>
						)),
					)}
					{layout.rows.map((row, i) => (
						<circle
							key={row.sha ?? "uncommitted"}
							cx={x(row.lane)}
							cy={y(i)}
							r={row.sha === null ? 4 : 5}
							className={`lane-${row.color % 8} ${row.sha === null ? "uncommitted" : ""}`}
						/>
					))}
				</svg>
				<ol aria-label="History" onKeyDown={move}>
					{layout.rows.map((row) => {
						const commit = row.sha === null ? null : bySha.get(row.sha);
						if (!commit) {
							const n = status.files.length;
							return (
								<li
									key="uncommitted"
									className={`graph-row ${selected === "" ? "selected" : ""}`}
								>
									<button
										type="button"
										className="graph-select uncommitted"
										aria-current={selected === "" || undefined}
										onClick={() => onSelect("")}
									>
										<span className="graph-subject">Uncommitted changes</span>
										<span className="graph-meta">
											{n} file{n === 1 ? "" : "s"}
											{status.merging ? " · merging" : ""}
										</span>
									</button>
								</li>
							);
						}
						const { chips, detached } = refChips(commit.refs, status.branch);
						const pulls = log.pulls.filter((p) => p.headSha === commit.sha);
						const isSelected = selected === commit.sha;
						return (
							<li
								key={commit.sha}
								className={`graph-row ${isSelected ? "selected" : ""}`}
							>
								<button
									type="button"
									className="graph-select"
									aria-current={isSelected || undefined}
									onClick={() => onSelect(commit.sha)}
								>
									{detached && (
										<span
											className="chip head"
											title="Your copy shows this version as a snapshot, not on a branch (detached HEAD)."
										>
											You are here
										</span>
									)}
									{chips.map((chip) => (
										<span
											key={`${chip.where}:${chip.name}`}
											className={`chip ${chip.where} ${chip.current ? "current" : ""}`}
											title={chipTitle(chip)}
										>
											{chip.where !== "local" && <Cloud />}
											{chip.name}
										</span>
									))}
									<span className="graph-subject">{commit.subject}</span>
									<span className="graph-meta">
										{commit.authorName} · <When iso={commit.date} />
									</span>
								</button>
								{pulls.map((p) => (
									<a
										key={p.number}
										className="pr-badge"
										href={p.url}
										target="_blank"
										rel="noreferrer"
										title={`${p.title}, open on GitHub`}
										aria-label={`Pull request #${p.number}: ${p.title} (opens GitHub)`}
									>
										#{p.number}
									</a>
								))}
							</li>
						);
					})}
				</ol>
			</div>
		</div>
	);
}

function ChangesView({
	id,
	status,
	filesKey,
	busy,
	onCommit,
	onCreateBranch,
	onDiscard,
}: {
	id: RepoId;
	status: GitStatus;
	/** Changes when any file changes, to reload the diff. */
	filesKey: string;
	busy: boolean;
	onCommit: (message: string) => Promise<boolean>;
	onCreateBranch: (name: string) => Promise<boolean>;
	onDiscard: () => void;
}) {
	const [diff, setDiff] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [branch, setBranch] = useState("");
	const messageId = useId();
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when files change
	useEffect(() => {
		let live = true;
		gitDiff(id).then(
			(d) => live && setDiff(d),
			() => live && setDiff(null),
		);
		return () => {
			live = false;
		};
	}, [id, filesKey]);
	useEffect(() => {
		if (status.merging) setMessage((m) => m || MERGE_MESSAGE);
	}, [status.merging]);

	const detached = status.branch === null;
	const files = status.files;
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (await onCommit(message)) setMessage("");
	};
	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (await onCreateBranch(branch.trim())) setBranch("");
	};

	return (
		<div className="changes">
			<h3>Uncommitted changes</h3>
			{detached && (
				<form className="snapshot" onSubmit={create}>
					<p>
						This copy shows one version as a <b>snapshot</b>, not a branch. To
						keep these changes, first create a branch: a named line of work that
						starts here and takes your changes along.
					</p>
					<div className="row">
						<label className="inline-field">
							Branch name
							<input
								value={branch}
								onChange={(e) => setBranch(e.target.value)}
								required
								placeholder="for example, gale-edits"
								spellCheck={false}
							/>
						</label>
						<button type="submit" className="primary" disabled={busy}>
							Create branch
						</button>
					</div>
				</form>
			)}
			{files.length === 0 ? (
				<p className="muted">
					{status.merging
						? "Nothing differs from your last commit. Commit to finish the merge."
						: "Nothing has changed since the last commit."}
				</p>
			) : (
				<ul className="file-list" aria-label="Changed files">
					{files.map((f) => (
						<li key={f.path}>
							<span className="file-path">{f.path}</span>
							<span className={`file-status ${f.status}`}>
								{statusWords[f.status]}
							</span>
						</li>
					))}
				</ul>
			)}
			{(files.length > 0 || status.merging) && (
				<form className="commit-form" onSubmit={submit}>
					<label htmlFor={messageId}>Describe your changes</label>
					<textarea
						id={messageId}
						rows={2}
						required
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						placeholder="For example: Tighten the abstract"
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								e.currentTarget.form?.requestSubmit();
							}
						}}
					/>
					{status.merging && (
						<p className="help">
							Committing finishes combining your work with the latest from
							GitHub. Revisions refuses while a file still has conflict markers.
						</p>
					)}
					{!status.permissions.push && !status.authError && (
						<p className="help">
							{WRITE_ACCESS} Your commits stay on this computer until then.
						</p>
					)}
					<div className="row">
						<button
							type="submit"
							className="primary"
							disabled={busy || detached}
							title={
								detached
									? "Create a branch first"
									: "Save a version of these changes on this computer (git commit)"
							}
						>
							Commit
						</button>
						<span className="spacer" />
						<button
							type="button"
							className="quiet danger"
							onClick={onDiscard}
							disabled={busy}
							title="Throw away every change since the last commit (git restore, git clean)"
						>
							Discard changes…
						</button>
					</div>
				</form>
			)}
			{diff !== null && files.length > 0 && <DiffView diff={diff} />}
		</div>
	);
}

function CommitView({
	id,
	sha,
	busy,
	onView,
}: {
	id: RepoId;
	sha: string;
	busy: boolean;
	/** Absent for the version already on screen. */
	onView?: () => void;
}) {
	const [detail, setDetail] = useState<CommitDetail | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let live = true;
		setDetail(null);
		setError("");
		gitCommitDetail(id, sha).then(
			(d) => live && setDetail(d),
			(e) => live && setError(failure(e).text),
		);
		return () => {
			live = false;
		};
	}, [id, sha]);
	if (error)
		return (
			<p role="alert" className="alert">
				{error}
			</p>
		);
	if (!detail)
		return (
			<p className="muted">
				<Spinner /> Loading…
			</p>
		);
	const [subject = "", ...rest] = detail.message.trim().split("\n");
	const body = rest.join("\n").trim();
	return (
		<div className="commit-detail">
			<h3>{subject}</h3>
			{body && <p className="commit-body">{body}</p>}
			<p className="muted">
				{detail.authorName} · <When iso={detail.date} /> ·{" "}
				<code title={detail.sha}>{detail.sha.slice(0, 7)}</code>
			</p>
			{onView && (
				<div className="row commit-view">
					<button
						type="button"
						onClick={onView}
						disabled={busy}
						title="Show the manuscript as it was at this commit, read-only (git switch --detach)"
					>
						View this version
					</button>
				</div>
			)}
			<DiffView diff={detail.diff} />
		</div>
	);
}

/** A native modal dialog that is open while mounted. While `busy`, its
 * action is running and Escape does not close it. */
export function Modal({
	title,
	wide = false,
	busy = false,
	onClose,
	children,
}: {
	title: string;
	wide?: boolean;
	busy?: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const busyRef = useRef(busy);
	busyRef.current = busy;
	// A layout effect, so close() runs while the dialog is still in the page
	// and the browser returns focus to the button that opened it.
	useLayoutEffect(() => {
		const d = ref.current;
		d?.showModal();
		return () => d?.close();
	}, []);
	// Escape is stopped before the browser turns it into a cancel, which a
	// repeated press could make uncancellable.
	useEffect(() => {
		if (!busy) return;
		const hold = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") event.preventDefault();
		};
		window.addEventListener("keydown", hold, true);
		return () => window.removeEventListener("keydown", hold, true);
	}, [busy]);
	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			className={wide ? "wide" : undefined}
			onCancel={(e) => {
				e.preventDefault();
				if (!busyRef.current) closeRef.current();
			}}
		>
			<h2 id={titleId}>{title}</h2>
			{children}
		</dialog>
	);
}

function BranchDialog({
	id,
	current,
	commits,
	flush,
	onAuthLost,
	onDone,
	onDeleted,
	onUnclean,
	onClose,
}: {
	id: RepoId;
	current: string | null;
	commits: Commit[];
	flush: () => Promise<boolean>;
	onAuthLost: () => void;
	onDone: (status: GitStatus) => void;
	/** The local branch `name` was deleted. */
	onDeleted: (status: GitStatus, name: string) => void;
	/** A switch met uncommitted changes: the panel shows the move prompt. */
	onUnclean: (unclean: Unclean) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const choices = branchChoices(commits).filter((b) => b.name !== current);

	const run = async (action: () => Promise<GitStatus>) => {
		setProblem(null);
		if (!(await flush())) {
			setProblem({ text: UNSAVED });
			return;
		}
		setBusy(true);
		try {
			onDone(await action());
		} catch (error) {
			if (error instanceof Unclean) onUnclean(error);
			else if (isCode(error, "auth_required")) onAuthLost();
			else setProblem(problemOf(error));
			setBusy(false);
		}
	};

	return (
		<Modal title="Branches" busy={busy} onClose={onClose}>
			<p className="muted">
				A branch is a separate, named line of work.{" "}
				{current ? (
					<>
						You are on <b>{current}</b>.
					</>
				) : (
					"Your copy is a snapshot, not on a branch."
				)}
			</p>
			<form
				className="settings"
				onSubmit={(e) => {
					e.preventDefault();
					run(() => gitCreateBranch(id, name.trim()));
				}}
			>
				<label>
					New branch name
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						spellCheck={false}
						placeholder="for example, revise-discussion"
					/>
				</label>
				<p className="help">
					It starts from the version you have now, and your uncommitted changes
					come along.
				</p>
				<div className="row end">
					<button type="submit" className="primary" disabled={busy}>
						Create and switch
					</button>
				</div>
			</form>
			<h3 className="dialog-section">Switch to another branch</h3>
			{choices.length === 0 ? (
				<p className="muted">There are no other branches.</p>
			) : (
				<ul className="branch-list">
					{choices.map((b) => (
						<li key={b.name}>
							<span className="branch-name">{b.name}</span>
							<span className="muted">
								{b.local && b.remote
									? "here and on GitHub"
									: b.local
										? "only on this computer"
										: "on GitHub"}
							</span>
							<button
								type="button"
								disabled={busy}
								onClick={() =>
									run(() =>
										runMove(id, {
											label: `Switch to branch ${b.name}`,
											run: () => gitCheckout(id, b.name),
											done: (s) => `You are now on branch ${s.branch}.`,
										}),
									)
								}
								aria-label={`Switch to ${b.name}`}
							>
								Switch
							</button>
							{b.local && (
								<button
									type="button"
									className="quiet danger"
									disabled={busy}
									onClick={() => setDeleting(b.name)}
									aria-label={`Delete ${b.name}…`}
								>
									Delete…
								</button>
							)}
						</li>
					))}
				</ul>
			)}
			{problem && <ProblemBox problem={problem} />}
			<div className="row end dialog-foot">
				<button type="button" onClick={onClose}>
					Close
				</button>
			</div>
			{deleting && (
				<DeleteBranchDialog
					id={id}
					name={deleting}
					onAuthLost={onAuthLost}
					onDeleted={(s) => onDeleted(s, deleting)}
					onClose={() => setDeleting(null)}
				/>
			)}
		</Modal>
	);
}

/** What a failed one-sweep pull request did and did not do, from the error's
 * `done`; "" when it did nothing. */
function stepsDone(error: unknown, branch: string, base: string): string {
	const done =
		error instanceof ApiError && Array.isArray(error.extra.done)
			? (error.extra.done as PullStep[])
			: [];
	if (done.length === 0) return "";
	const said: string[] = [];
	if (done.includes("branch")) {
		said.push(
			`Branch ${branch} was created, and you are on it with your changes.`,
			done.includes("base")
				? `Branch ${base} was moved back to match GitHub.`
				: `Branch ${base} was left as it was.`,
		);
	}
	said.push(
		done.includes("sent")
			? "Your branch was sent to GitHub."
			: "Nothing was sent to GitHub.",
		"The pull request was not opened, and nothing was retried.",
	);
	return said.join(" ");
}

function PullDialog({
	id,
	branch,
	defaultBranch,
	defaultTitle,
	flush,
	after,
	onAuthLost,
	onClose,
}: {
	id: RepoId;
	/** The current branch. */
	branch: string | null;
	defaultBranch: string | null;
	defaultTitle: string;
	flush: () => Promise<boolean>;
	after: () => void;
	onAuthLost: () => void;
	onClose: () => void;
}) {
	const [form, setForm] = useState({
		title: defaultTitle,
		body: "",
		base: "",
		branch: "",
	});
	const [created, setCreated] = useState<PullRequest | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	// The server said the current branch is the base, which the page could not tell.
	const [askBranch, setAskBranch] = useState(false);
	const [busy, setBusy] = useState(false);

	const base = form.base.trim() || defaultBranch;
	const onBase = askBranch || (branch !== null && branch === base);
	const open = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		if (!(await flush())) {
			setProblem({ text: UNSAVED });
			return;
		}
		const newBranch = onBase ? form.branch.trim() : "";
		setBusy(true);
		try {
			setCreated(
				await createPull(
					id,
					form.title,
					form.body,
					form.base.trim(),
					newBranch,
				),
			);
		} catch (error) {
			if (isCode(error, "auth_required")) onAuthLost();
			setAskBranch((a) => a || isCode(error, "needs_branch"));
			const p = problemOf(error);
			const steps = stepsDone(error, newBranch, base ?? "the base branch");
			// GitHub's refusal of a just-made branch is best said in its own words.
			const why =
				steps && isCode(error, "rejected")
					? (error as ApiError).message
					: p.text;
			setProblem({ ...p, text: steps ? `${steps} Why: ${why}` : p.text });
		} finally {
			setBusy(false);
			after();
		}
	};

	if (created) {
		return (
			<Modal title="Open a pull request" onClose={onClose}>
				<p>
					Your pull request is open on GitHub:{" "}
					<a href={created.url} target="_blank" rel="noreferrer">
						#{created.number} {created.title}
					</a>
					. Your co-authors can review it there, and the history marks it with
					its number.
				</p>
				<div className="row end">
					<button type="button" className="primary" onClick={onClose}>
						Close
					</button>
				</div>
			</Modal>
		);
	}
	return (
		<Modal title="Open a pull request" busy={busy} onClose={onClose}>
			<p className="muted">
				A pull request asks the author to review your branch and take it into
				the manuscript.
			</p>
			<form className="settings" onSubmit={open}>
				<label>
					Title
					<input
						value={form.title}
						onChange={(e) => setForm({ ...form, title: e.target.value })}
						required
					/>
				</label>
				<label>
					Description
					<textarea
						rows={4}
						value={form.body}
						onChange={(e) => setForm({ ...form, body: e.target.value })}
						placeholder="What did you change, and why?"
					/>
				</label>
				<label>
					Into branch
					<input
						value={form.base}
						onChange={(e) => setForm({ ...form, base: e.target.value })}
						placeholder="the repository's main branch"
						spellCheck={false}
						aria-describedby="pull-base-help"
					/>
				</label>
				<p id="pull-base-help" className="help">
					Leave empty to use the repository's default branch.
				</p>
				{onBase && (
					<>
						<label>
							New branch name
							<input
								value={form.branch}
								onChange={(e) => setForm({ ...form, branch: e.target.value })}
								placeholder="for example, gale-edits"
								spellCheck={false}
								aria-describedby="pull-branch-help"
							/>
						</label>
						<p id="pull-branch-help" className="help">
							You are on {base ?? "the branch the pull request goes into"}. Your
							commits move to this new branch, which is sent to GitHub, and{" "}
							{base ?? "that branch"} goes back to match GitHub. Uncommitted
							changes come along to the new branch but are not part of the pull
							request.
						</p>
					</>
				)}
				{problem && <ProblemBox problem={problem} />}
				<div className="row end">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={busy}>
						Open pull request
					</button>
				</div>
			</form>
		</Modal>
	);
}

function ForcePushDialog({
	id,
	branch,
	onAuthLost,
	onSent,
	onSendInstead,
	onClose,
}: {
	id: RepoId;
	branch: string;
	onAuthLost: () => void;
	onSent: () => void;
	onSendInstead: () => void;
	onClose: () => void;
}) {
	const [preview, setPreview] = useState<{
		remoteSha: string;
		commits: Commit[];
	} | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);

	const fail = useCallback(
		(error: unknown) => {
			if (isCode(error, "auth_required")) onAuthLost();
			setProblem(problemOf(error));
			setPreview(null);
		},
		[onAuthLost],
	);
	useEffect(() => {
		gitForcePushPreview(id).then(setPreview, fail);
	}, [id, fail]);

	const confirm = async () => {
		if (!preview) return;
		setProblem(null);
		setBusy(true);
		try {
			// The lease is the remote commit this dialog listed: if GitHub has
			// moved since, the server refuses and nothing is erased.
			await gitForcePush(id, preview.remoteSha);
			onSent();
		} catch (error) {
			if (isCode(error, "rejected")) {
				setPreview(null);
				try {
					setPreview(await gitForcePushPreview(id));
					setProblem({
						text: "The branch on GitHub changed after this list was made, so nothing was sent. The list below is up to date: check it again.",
					});
				} catch (again) {
					fail(again);
				}
			} else {
				fail(error);
			}
		} finally {
			setBusy(false);
		}
	};

	const n = preview?.commits.length ?? 0;
	return (
		<Modal
			title="Force-push: replace the branch on GitHub"
			wide
			busy={busy}
			onClose={onClose}
		>
			{problem && <ProblemBox problem={problem} />}
			{!preview && (
				<div className="row end">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
				</div>
			)}
			{!preview ? (
				!problem && (
					<p className="muted">
						<Spinner /> Checking what GitHub has…
					</p>
				)
			) : n === 0 ? (
				<>
					<p>
						GitHub has no commits on <b>{branch}</b> that your copy lacks, so
						nothing would be erased. A normal Send is enough.
					</p>
					<div className="row end">
						<button type="button" onClick={onClose}>
							Cancel
						</button>
						<button type="button" className="primary" onClick={onSendInstead}>
							Send
						</button>
					</div>
				</>
			) : (
				<>
					<p>
						This makes the branch <b>{branch}</b> on GitHub match your copy.{" "}
						{n === 1 ? "This commit is" : `These ${n} commits are`} on GitHub
						but not in your copy, and will be <b>erased from GitHub</b>:
					</p>
					<ul className="erase-list" aria-label="Commits that will be erased">
						{preview.commits.map((c) => (
							<li key={c.sha}>
								<span className="erase-subject">{c.subject}</span>
								<span className="muted">
									{c.authorName} · <When iso={c.date} /> ·{" "}
									<code title={c.sha}>{c.sha.slice(0, 7)}</code>
								</span>
							</li>
						))}
					</ul>
					<p className="help">
						If you are not sure, cancel and use Get latest instead: it keeps
						everyone's work.
					</p>
					<div className="row end">
						<button type="button" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="danger-button"
							disabled={busy}
							onClick={confirm}
						>
							{n === 1
								? "Erase this commit and send mine"
								: `Erase these ${n} commits and send mine`}
						</button>
					</div>
				</>
			)}
		</Modal>
	);
}

function DiscardDialog({
	id,
	merging,
	onAuthLost,
	onDiscarded,
	onClose,
}: {
	id: RepoId;
	merging: boolean;
	onAuthLost: () => void;
	onDiscarded: () => void;
	onClose: () => void;
}) {
	const [preview, setPreview] = useState<DiscardPreview | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);

	const fail = useCallback(
		(error: unknown) => {
			if (isCode(error, "auth_required")) onAuthLost();
			else setProblem(problemOf(error));
		},
		[onAuthLost],
	);
	useEffect(() => {
		gitDiscardPreview(id).then(setPreview, fail);
	}, [id, fail]);

	const confirm = async () => {
		if (!preview) return;
		setProblem(null);
		setBusy(true);
		try {
			await gitDiscard(id, preview.fingerprint);
			onDiscarded();
		} catch (error) {
			if (isCode(error, "changed")) {
				setProblem({
					text: "The changes are different from a moment ago, so nothing was discarded. The list below is up to date: check it again.",
				});
				gitDiscardPreview(id).then(setPreview, fail);
			} else fail(error);
		} finally {
			setBusy(false);
		}
	};

	const files = preview?.files ?? [];
	return (
		<Modal title="Discard your changes?" wide busy={busy} onClose={onClose}>
			{problem && <ProblemBox problem={problem} />}
			{!preview ? (
				!problem && (
					<p className="muted">
						<Spinner /> Collecting your changes…
					</p>
				)
			) : files.length === 0 ? (
				<>
					<p>There is nothing to discard.</p>
					<div className="row end">
						<button type="button" onClick={onClose}>
							Close
						</button>
					</div>
				</>
			) : (
				<>
					<p>
						This throws away every change since the last commit, shown below.
						New files are deleted.{" "}
						{merging && "It also undoes the merge in progress. "}
						<b>It cannot be undone.</b>
					</p>
					<div className="dialog-diff">
						<DiffView diff={preview.diff} />
					</div>
					<div className="row end">
						<button type="button" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="danger-button"
							disabled={busy}
							onClick={confirm}
						>
							Discard these changes
						</button>
					</div>
				</>
			)}
		</Modal>
	);
}

/** Confirms deleting a local branch, listing the commits only it holds. */
function DeleteBranchDialog({
	id,
	name,
	onAuthLost,
	onDeleted,
	onClose,
}: {
	id: RepoId;
	name: string;
	onAuthLost: () => void;
	onDeleted: (status: GitStatus) => void;
	onClose: () => void;
}) {
	const [preview, setPreview] = useState<DeletePreview | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);

	const fail = useCallback(
		(error: unknown) => {
			if (isCode(error, "auth_required")) onAuthLost();
			else setProblem(problemOf(error));
		},
		[onAuthLost],
	);
	useEffect(() => {
		gitDeletePreview(id, name).then(setPreview, fail);
	}, [id, name, fail]);

	const confirm = async () => {
		if (!preview) return;
		setProblem(null);
		setBusy(true);
		try {
			onDeleted(await gitDeleteBranch(id, name, preview.fingerprint));
		} catch (error) {
			if (isCode(error, "changed")) {
				setProblem({
					text: "The branch changed after this list was made, so nothing was deleted. The list below is up to date: check it again.",
				});
				gitDeletePreview(id, name).then(setPreview, fail);
			} else fail(error);
		} finally {
			setBusy(false);
		}
	};

	const n = preview?.commits.length ?? 0;
	return (
		<Modal title={`Delete branch ${name}?`} wide busy={busy} onClose={onClose}>
			{problem && <ProblemBox problem={problem} />}
			{!preview ? (
				!problem && (
					<p className="muted">
						<Spinner /> Looking for commits only this branch has…
					</p>
				)
			) : n === 0 ? (
				<p>
					Every commit on <b>{name}</b> is kept elsewhere, on another branch or
					on GitHub, so deleting it loses nothing.
				</p>
			) : (
				<>
					<p>
						{n === 1 ? "This commit exists" : `These ${n} commits exist`} only
						on <b>{name}</b>. Deleting the branch means{" "}
						{n === 1 ? "it" : "they"} will be <b>lost from this computer</b>:
					</p>
					<ul className="erase-list" aria-label="Commits that will be lost">
						{preview.commits.map((c) => (
							<li key={c.sha}>
								<span className="erase-subject">{c.subject}</span>
								<span className="muted">
									<When iso={c.date} /> ·{" "}
									<code title={c.sha}>{c.sha.slice(0, 7)}</code>
								</span>
							</li>
						))}
					</ul>
				</>
			)}
			<p className="help">
				This deletes the branch on this computer only. GitHub is not changed.
			</p>
			<div className="row end">
				<button type="button" onClick={onClose} disabled={busy}>
					Cancel
				</button>
				{preview && (
					<button
						type="button"
						className="danger-button"
						disabled={busy}
						onClick={confirm}
					>
						{busy && <Spinner />}Delete branch
					</button>
				)}
			</div>
		</Modal>
	);
}

const MERGING =
	"This copy is in the middle of a merge. Finish or undo the merge first: commit to finish it, or choose Undo this merge in Changes & history.";

/** A move: anything that changes which version the working copy holds. */
export interface Move<T = unknown> {
	/** The destination in plain words; the move prompt's title. */
	label: string;
	run(): Promise<T>;
	/** What to say once the move is done. */
	done?(result: T): string;
}

/** Thrown by {@link runMove} when uncommitted changes need the move prompt. */
export class Unclean extends Error {
	constructor(
		readonly move: Move,
		readonly status: GitStatus,
	) {
		super(move.label);
	}
}

/**
 * Runs `move` on clone `id`. The server decides whether the copy is clean:
 * its 409 `dirty` throws {@link Unclean} for the move prompt, or, during an
 * unfinished merge, the refusal (code `merging`). Save pending text first.
 */
export async function runMove<T>(id: RepoId, move: Move<T>): Promise<T> {
	try {
		return await move.run();
	} catch (error) {
		if (!isCode(error, "dirty")) throw error;
		const status = await gitStatus(id);
		if (status.merging) throw new ApiError(409, "merging", MERGING, {});
		throw new Unclean(move, status);
	}
}

/**
 * The move prompt: lists the uncommitted changes that block a move and
 * offers Commit (not on a snapshot), Discard, and Cancel. After a commit or
 * a confirmed discard it makes the move once; if that fails it says what
 * was kept or thrown away and why the move did not happen. `children` adds
 * buttons beside Cancel.
 */
export function MovePrompt({
	id,
	unclean,
	onMoved,
	onClose,
	onAuthLost,
	children,
}: {
	id: RepoId;
	unclean: Unclean;
	/** The move is done; `message` says what happened. */
	onMoved: (message: string) => void;
	/** Cancel, or Close after a failure. */
	onClose: () => void;
	onAuthLost: () => void;
	children?: ReactNode;
}) {
	const { move, status } = unclean;
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [failed, setFailed] = useState<Problem | null>(null);
	const [discarding, setDiscarding] = useState(false);
	const messageId = useId();

	/** After a commit or discard (`kept`): the move, once. */
	const finish = async (kept: string) => {
		setBusy(true);
		try {
			const result = await move.run();
			onMoved(`${kept} ${move.done?.(result) ?? ""}`.trim());
		} catch (error) {
			if (isCode(error, "auth_required")) onAuthLost();
			const why = problemOf(error);
			setFailed({
				...why,
				text: `${kept} “${move.label}” did not happen. ${why.text}`,
			});
		} finally {
			setBusy(false);
		}
	};
	const commit = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		setBusy(true);
		try {
			await gitCommit(id, message);
		} catch (error) {
			if (isCode(error, "auth_required")) onAuthLost();
			setProblem(problemOf(error));
			setBusy(false);
			return;
		}
		await finish(
			`Your changes were committed on this computer as “${message.trim()}”.`,
		);
	};

	return (
		<>
			<Modal title={move.label} wide busy={busy} onClose={onClose}>
				{failed ? (
					<>
						<ProblemBox problem={failed} />
						<div className="row end">
							<button type="button" className="primary" onClick={onClose}>
								Close
							</button>
						</div>
					</>
				) : (
					<>
						<p>
							Your copy has changes that are not committed. Commit them to keep
							them, or discard them; Revisions then continues.
						</p>
						<ul className="file-list" aria-label="Changed files">
							{status.files.map((f) => (
								<li key={f.path}>
									<span className="file-path">{f.path}</span>
									<span className={`file-status ${f.status}`}>
										{statusWords[f.status]}
									</span>
								</li>
							))}
						</ul>
						{status.branch === null ? (
							<p className="help">
								This copy is a snapshot of an earlier version, so these changes
								cannot be committed. Discard them, or cancel and start a branch
								to keep them.
							</p>
						) : (
							<form className="commit-form" onSubmit={commit}>
								<label htmlFor={messageId}>Describe your changes</label>
								<textarea
									id={messageId}
									rows={2}
									required
									value={message}
									onChange={(e) => setMessage(e.target.value)}
									placeholder="For example: Tighten the abstract"
								/>
								<p className="help">
									Commit records every change on branch {status.branch}, then
									Revisions continues.
								</p>
								<div className="row">
									<button type="submit" className="primary" disabled={busy}>
										{busy && <Spinner />}Commit
									</button>
								</div>
							</form>
						)}
						{problem && <ProblemBox problem={problem} />}
						<div className="row end dialog-foot">
							{children}
							<button
								type="button"
								className="quiet danger"
								onClick={() => setDiscarding(true)}
								disabled={busy}
							>
								Discard…
							</button>
							<button type="button" onClick={onClose} disabled={busy}>
								Cancel
							</button>
						</div>
					</>
				)}
			</Modal>
			{discarding && (
				<DiscardDialog
					id={id}
					merging={false}
					onAuthLost={onAuthLost}
					onDiscarded={() => {
						setDiscarding(false);
						finish("Your changes were discarded.");
					}}
					onClose={() => setDiscarding(false)}
				/>
			)}
		</>
	);
}
