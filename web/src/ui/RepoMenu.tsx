// The menu on each repository Home lists: Show in folder, Copy path,
// Properties, and Remove or Unlink. See "Manage a repository from Home" in
// specs/git-workflow.md.
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	previewRemove,
	type RemovePreview,
	type RepoSummary,
	removeRepo,
	revealFolder,
} from "../api/client";
import {
	type CommitDetail,
	type GitStatus,
	gitCommitDetail,
	gitStatus,
} from "../api/git";
import { explain, isCode } from "./errors";
import {
	Modal,
	ProblemBox,
	problemOf,
	Spinner,
	statusWords,
	When,
} from "./Git";

type Open = "menu" | "properties" | "remove" | null;

const nameOf = (repo: RepoSummary) => repo.id.split("/").slice(1).join("/");

export function RepoMenu({
	repo,
	onRemoved,
	onAuthLost,
}: {
	repo: RepoSummary;
	onRemoved: () => void;
	onAuthLost: () => void;
}) {
	const [open, setOpen] = useState<Open>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const box = useRef<HTMLSpanElement>(null);

	// Escape or a click elsewhere closes the menu.
	useEffect(() => {
		if (open !== "menu") return;
		const away = (event: MouseEvent) => {
			if (!box.current?.contains(event.target as Node)) setOpen(null);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(null);
		};
		document.addEventListener("mousedown", away);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", away);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const item = (label: string, run: () => void, danger = false) => (
		<button
			type="button"
			role="menuitem"
			className={danger ? "quiet danger-item" : "quiet"}
			onClick={run}
		>
			{label}
		</button>
	);

	return (
		<span className="repo-menu" ref={box}>
			<button
				type="button"
				className="quiet"
				aria-label={`Actions for ${nameOf(repo)}`}
				aria-haspopup="menu"
				aria-expanded={open === "menu"}
				onClick={() => {
					setError(null);
					setCopied(false);
					setOpen(open === "menu" ? null : "menu");
				}}
			>
				⋯
			</button>
			{open === "menu" && (
				<div
					className="popover repo-menu-list"
					role="menu"
					aria-label={nameOf(repo)}
				>
					{item("Show in folder", () => {
						setOpen(null);
						revealFolder(repo.id).catch((e) => setError(explain(e)));
					})}
					{item(copied ? "Copied" : "Copy path", () => {
						navigator.clipboard.writeText(repo.path).then(
							() => setCopied(true),
							() => setError("Revisions could not use the clipboard."),
						);
					})}
					{item("Properties…", () => setOpen("properties"))}
					{repo.linked
						? item("Unlink…", () => setOpen("remove"), true)
						: item("Remove…", () => setOpen("remove"), true)}
				</div>
			)}
			{error && (
				<span role="alert" className="popover-error repo-menu-error">
					{error}
				</span>
			)}
			{open === "properties" && (
				<Properties repo={repo} onClose={() => setOpen(null)} />
			)}
			{open === "remove" && (
				<Remove
					repo={repo}
					onAuthLost={onAuthLost}
					onClose={() => setOpen(null)}
					onRemoved={() => {
						setOpen(null);
						onRemoved();
					}}
				/>
			)}
		</span>
	);
}

const plural = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

function Row({ term, children }: { term: string; children: ReactNode }) {
	return (
		<div>
			<dt>{term}</dt>
			<dd>{children}</dd>
		</div>
	);
}

function Properties({
	repo,
	onClose,
}: {
	repo: RepoSummary;
	onClose: () => void;
}) {
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [commit, setCommit] = useState<CommitDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		gitStatus(repo.id).then(setStatus, (e) => setError(explain(e)));
		if (repo.head)
			gitCommitDetail(repo.id, repo.head).then(setCommit, () => {});
	}, [repo]);

	const waiting = "…";
	return (
		<Modal title={`Properties of ${nameOf(repo)}`} wide onClose={onClose}>
			{error && (
				<p role="alert" className="alert">
					{error}
				</p>
			)}
			<dl className="properties">
				<Row term="Repository">
					<a href={`https://${repo.id}`} target="_blank" rel="noreferrer">
						{nameOf(repo)}
					</a>
				</Row>
				<Row term="Kind">
					{repo.linked ? "Linked folder" : "Copy in the Revisions folder"}
				</Row>
				<Row term="Folder">
					<code>{repo.path}</code>
				</Row>
				<Row term="Origin">
					{repo.origin ? <code>{repo.origin}</code> : "None"}
				</Row>
				<Row term="Branch">
					{status?.snapshot
						? `Snapshot of “${status.snapshot.subject}”`
						: (repo.branch ?? "None")}
				</Row>
				<Row term="Latest commit">
					{repo.head ? (
						<>
							<code title={repo.head}>{repo.head.slice(0, 7)}</code>
							{commit && (
								<>
									{" "}
									{commit.message.split("\n")[0]} · <When iso={commit.date} />
								</>
							)}
						</>
					) : (
						"None yet"
					)}
				</Row>
				<Row term="Default branch">
					{status ? (status.defaultBranch ?? "Unknown") : waiting}
				</Row>
				<Row term="Not on GitHub yet">
					{status
						? `${plural(status.files.length, "file with uncommitted changes", "files with uncommitted changes")}, ${plural(status.unsent, "commit", "commits")} on this branch`
						: waiting}
				</Row>
			</dl>
			<div className="row end">
				<button type="button" onClick={onClose}>
					Close
				</button>
			</div>
		</Modal>
	);
}

function Remove({
	repo,
	onAuthLost,
	onClose,
	onRemoved,
}: {
	repo: RepoSummary;
	onAuthLost: () => void;
	onClose: () => void;
	onRemoved: () => void;
}) {
	const [preview, setPreview] = useState<RemovePreview | null>(null);
	const [problem, setProblem] = useState<ReturnType<typeof problemOf> | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const fail = useCallback(
		(error: unknown) => {
			if (isCode(error, "auth_required")) onAuthLost();
			setProblem(problemOf(error));
		},
		[onAuthLost],
	);
	useEffect(() => {
		previewRemove(repo.id).then(setPreview, fail);
	}, [repo.id, fail]);

	const confirm = async () => {
		if (!preview) return;
		setProblem(null);
		setBusy(true);
		try {
			await removeRepo(repo.id, preview.fingerprint);
			onRemoved();
		} catch (error) {
			setBusy(false);
			if (isCode(error, "changed")) {
				setProblem({
					text: "The repository changed after this list was made, so nothing was removed. The list below is up to date: check it again.",
				});
				previewRemove(repo.id).then(setPreview, fail);
			} else fail(error);
		}
	};

	const name = nameOf(repo);
	const lost = preview ? preview.files.length + preview.commits.length : 0;
	return (
		<Modal
			title={
				repo.linked ? `Unlink ${name}?` : `Remove ${name} from this computer?`
			}
			wide
			busy={busy}
			onClose={onClose}
		>
			{problem && <ProblemBox problem={problem} />}
			{!preview ? (
				!problem && (
					<p className="muted">
						<Spinner /> Looking for work that is not on GitHub…
					</p>
				)
			) : preview.linked ? (
				<p>
					Revisions stops listing this repository. The folder{" "}
					<code>{preview.path}</code> stays as it is, with all its files and Git
					history. You can link it again at any time.
				</p>
			) : (
				<>
					<p>
						This deletes the folder <code>{preview.path}</code> and everything
						in it.
					</p>
					{lost === 0 ? (
						<p>Everything in it is on GitHub, so nothing is lost.</p>
					) : (
						<p>
							This work is not on GitHub and will be{" "}
							<b>lost from this computer</b>:
						</p>
					)}
					{preview.files.length > 0 && (
						<ul
							className="erase-list"
							aria-label="Uncommitted changes that will be lost"
						>
							{preview.files.map((f) => (
								<li key={f.path}>
									<span className="erase-subject">{f.path}</span>
									<span className="muted">{statusWords[f.status]}</span>
								</li>
							))}
						</ul>
					)}
					{preview.commits.length > 0 && (
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
					)}
				</>
			)}
			<p className="help">
				GitHub is not changed.
				{!repo.linked &&
					" You can open the manuscript again from its GitHub link."}
			</p>
			<div className="row end">
				<button type="button" onClick={onClose} disabled={busy}>
					Cancel
				</button>
				{preview && (
					<button
						type="button"
						className={preview.linked ? "primary" : "danger-button"}
						disabled={busy}
						onClick={confirm}
					>
						{busy && <Spinner />}
						{preview.linked ? "Unlink" : "Delete folder"}
					</button>
				)}
			</div>
		</Modal>
	);
}
