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
	type DiscardPreview,
	type FileStatus,
	type GitStatus,
	gitCheckout,
	gitCommit,
	gitCommitDetail,
	gitCreateBranch,
	gitDiff,
	gitDiscard,
	gitDiscardPreview,
	gitFetch,
	gitForcePush,
	gitForcePushPreview,
	gitLog,
	gitMergeAbort,
	gitPull,
	gitPush,
	gitStatus,
	type PullRequest,
} from "../api/git";
import type { RepoState } from "../api/repo";
import { layoutGraph } from "../core/graph/graph";
import { branchChoices, type RefChip, refChips } from "../core/graph/refs";
import { DiffView } from "./Diff";
import { failure, isCode } from "./errors";

export const statusWords: Record<FileStatus["status"], string> = {
	modified: "changed",
	added: "added",
	deleted: "deleted",
	renamed: "renamed",
	untracked: "new",
	conflicted: "has conflicts",
};

const MERGE_MESSAGE = "Combine my changes with the latest from GitHub";
const UNSAVED =
	"Your latest edits could not be saved, so nothing was done. See the message above the editor.";

interface Problem {
	text: string;
	details?: string;
	files?: string[];
}

/** The sentence, Git's details, and the files an error names. */
function problemOf(error: unknown): Problem {
	const files =
		error instanceof ApiError && Array.isArray(error.extra.files)
			? (error.extra.files as (string | FileStatus)[]).map((f) =>
					typeof f === "string" ? f : `${f.path} (${statusWords[f.status]})`,
				)
			: undefined;
	return { ...failure(error), files };
}

interface Log {
	commits: Commit[];
	pulls: PullRequest[];
}

type DialogName = "branch" | "pull" | "force" | "discard";

/** "" selects the uncommitted changes. */
type Selection = string;

export function GitPanel({
	id,
	state,
	flush,
	onChanged,
	onOpenSource,
	onAuthLost,
	onClose,
}: {
	id: RepoId;
	/** The 2-second state poll; the panel refreshes when it changes. */
	state: RepoState | null;
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

	// What this computer knows at once, then what GitHub has.
	useEffect(() => {
		heading.current?.focus();
		gitFetch(id).then(refresh, () => {});
	}, [id, refresh]);

	const headKey = state ? `${state.git.head} ${state.git.branch}` : "";
	const filesKey = state
		? `${state.git.dirty} ${Object.values(state.hashes).join()}`
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the checkout moves
	useEffect(() => {
		refresh();
	}, [refresh, headKey]);
	useEffect(() => {
		if (filesKey) gitStatus(id).then(setStatus, () => {});
	}, [id, filesKey]);

	const after = useCallback(() => {
		refresh();
		onChanged();
	}, [refresh, onChanged]);

	const report = (error: unknown) => {
		if (isCode(error, "auth_required")) return onAuthLost();
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
			report(error);
			return false;
		} finally {
			setBusy("");
			after();
		}
	};

	const getLatest = () =>
		act(
			"pull",
			() => gitPull(id),
			(s) => (s.merging ? "" : "Your copy is up to date with GitHub."),
		);
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
				s.ahead > 0 && s.permissions.push
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
	const abortMerge = () =>
		act(
			"abort",
			() => gitMergeAbort(id),
			() => "The merge was undone. Your copy is as it was before Get latest.",
		);
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
						{(status?.ahead ?? 0) > 0 && (
							<span className="count" aria-hidden="true">
								{status?.ahead}
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
					Send and pull requests are not offered; you can still commit on this
					computer, and the author can give your account write access on GitHub.
				</p>
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
						<CommitView id={id} sha={shown} />
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
					onClose={() => closeDialog()}
				/>
			)}
			{dialog === "pull" && status && (
				<PullDialog
					id={id}
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
	if (s.ahead > 0)
		parts.push(`${s.ahead} commit${s.ahead === 1 ? "" : "s"} to send`);
	if (s.behind > 0) parts.push(`${s.behind} new on GitHub`);
	if (s.ahead === 0 && s.behind === 0) parts.push("in sync with GitHub");
	return parts.join(" · ");
}

const Spinner = () => <span className="spinner" aria-hidden="true" />;

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

function When({ iso }: { iso: string }) {
	const seconds = (Date.parse(iso) - Date.now()) / 1000;
	const unit = UNITS.find(([, n]) => Math.abs(seconds) >= n);
	return (
		<time dateTime={iso} title={new Date(iso).toLocaleString()}>
			{unit ? rtf.format(Math.round(seconds / unit[1]), unit[0]) : "just now"}
		</time>
	);
}

function ProblemBox({
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
						You opened a link to one version, so this copy is a <b>snapshot</b>,
						not a branch. To keep your changes, first create a branch: a named
						line of work that starts here and takes your changes along.
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

function CommitView({ id, sha }: { id: RepoId; sha: string }) {
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
			<DiffView diff={detail.diff} />
		</div>
	);
}

/** A native modal dialog that is open while mounted. */
export function Modal({
	title,
	wide = false,
	onClose,
	children,
}: {
	title: string;
	wide?: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	// A layout effect, so close() runs while the dialog is still in the page
	// and the browser returns focus to the button that opened it.
	useLayoutEffect(() => {
		const d = ref.current;
		d?.showModal();
		return () => d?.close();
	}, []);
	return (
		<dialog
			ref={ref}
			aria-labelledby={titleId}
			className={wide ? "wide" : undefined}
			onCancel={(e) => {
				e.preventDefault();
				closeRef.current();
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
	onClose,
}: {
	id: RepoId;
	current: string | null;
	commits: Commit[];
	flush: () => Promise<boolean>;
	onAuthLost: () => void;
	onDone: (status: GitStatus) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const [problem, setProblem] = useState<Problem | null>(null);
	const [busy, setBusy] = useState(false);
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
			if (isCode(error, "auth_required")) onAuthLost();
			else setProblem(problemOf(error));
			setBusy(false);
		}
	};

	return (
		<Modal title="Branches" onClose={onClose}>
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
								onClick={() => run(() => gitCheckout(id, b.name))}
								aria-label={`Switch to ${b.name}`}
							>
								Switch
							</button>
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
		</Modal>
	);
}

function PullDialog({
	id,
	defaultTitle,
	flush,
	after,
	onAuthLost,
	onClose,
}: {
	id: RepoId;
	defaultTitle: string;
	flush: () => Promise<boolean>;
	after: () => void;
	onAuthLost: () => void;
	onClose: () => void;
}) {
	const [form, setForm] = useState({ title: defaultTitle, body: "", base: "" });
	const [created, setCreated] = useState<PullRequest | null>(null);
	const [problem, setProblem] = useState<Problem | null>(null);
	const [needsSend, setNeedsSend] = useState(false);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);

	const fail = (error: unknown) => {
		if (isCode(error, "auth_required")) return onAuthLost();
		setProblem(problemOf(error));
		setNeedsSend(isCode(error, "not_pushed"));
	};
	const open = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		setNote("");
		setBusy(true);
		try {
			setCreated(await createPull(id, form.title, form.body, form.base.trim()));
			after();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
		}
	};
	const send = async () => {
		setProblem(null);
		if (!(await flush())) {
			setProblem({ text: UNSAVED });
			return;
		}
		setBusy(true);
		try {
			await gitPush(id);
			setNote("Sent. Now open the pull request.");
			after();
		} catch (error) {
			fail(error);
		} finally {
			setBusy(false);
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
		<Modal title="Open a pull request" onClose={onClose}>
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
				{problem && (
					<ProblemBox problem={problem}>
						{needsSend && (
							<button type="button" onClick={send} disabled={busy}>
								Send now
							</button>
						)}
					</ProblemBox>
				)}
				<p role="status" className="git-done">
					{note}
				</p>
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
			else setProblem(problemOf(error));
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
			onClose={onClose}
		>
			{problem && <ProblemBox problem={problem} />}
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
		<Modal title="Discard your changes?" wide onClose={onClose}>
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
