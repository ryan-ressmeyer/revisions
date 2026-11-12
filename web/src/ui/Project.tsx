import { Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	type Env,
	getAuth,
	getEnv,
	getSettings,
	type Platform,
	putSettings,
	type RepoId,
} from "../api/client";
import {
	gitCheckout,
	gitCreateBranch,
	gitStatus,
	type Snapshot,
} from "../api/git";
import {
	type BuildStatus,
	cancelBuild,
	getBuild,
	getPdfLog,
	getProject,
	getState,
	type Project,
	type ProjectFile,
	putEntry,
	putFile,
	type RepoState,
	startBuild,
	synctexForward,
	synctexInverse,
} from "../api/repo";
import {
	addComment,
	addHighlight,
	applyEdits,
	type Edit,
	ensurePreamble,
} from "../core/changes/changes";
import type { SourceFile } from "../core/latex/project";
import type { FileSync, SyncStatus } from "../core/sync/sync";
import { Editor, goToLine } from "./Editor";
import { editFilter } from "./edits";
import { explain, isCode } from "./errors";
import { FileTree } from "./FileTree";
import { figureUrl } from "./figures";
import { loadFile, openFileSync } from "./files";
import { GitPanel, Modal } from "./Git";
import { TexGuidance } from "./Guidance";
import { type PdfHandle, PdfView } from "./Pdf";
import {
	type Author,
	AuthorDialog,
	CommentPopover,
	changesIn,
	createEditorStore,
	type EditorStore,
	ReviewPanel,
	storeListener,
	useEditorState,
} from "./Review";
import { refreshRich, richView } from "./rich";

interface OpenFile {
	path: string;
	sync: FileSync;
}

interface Jump {
	line: number;
	column: number;
}

const mod = (platform: Platform) => (platform === "darwin" ? "⌘" : "Ctrl+");

const LOCKED =
	"This is an earlier version, so it cannot be changed. Go back to your branch, or start a branch from this version, to edit.";

/** The editor and the PDF of one repository, side by side. */
export function ProjectView({
	id,
	env,
	settings,
	onEnvChange,
	onAuthLost,
}: {
	id: RepoId;
	env: Env;
	/** The Settings button, which the app owns. */
	settings: ReactNode;
	onEnvChange: (env: Env) => void;
	/** GitHub answered auth_required: the app shows sign-in. */
	onAuthLost: () => void;
}) {
	const [project, setProject] = useState<Project | null>(null);
	const [loadFailure, setLoadFailure] = useState("");
	const [file, setFile] = useState<OpenFile | null>(null);
	const [repoState, setRepoState] = useState<RepoState | null>(null);
	const [build, setBuild] = useState<BuildStatus | null>(null);
	const [texMissing, setTexMissing] = useState(!env.latexmk.found);
	const [notice, setNotice] = useState("");
	const [zoom, setZoom] = useState(1);

	const fileRef = useRef(file);
	fileRef.current = file;
	const view = useRef<EditorView | null>(null);
	const pendingJump = useRef<Jump | null>(null);
	const openCount = useRef(0);
	const pdf = useRef<PdfHandle>(null);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(""), 8000);
		return () => clearTimeout(timer);
	}, [notice]);

	const [panes, setPanes] = useStored<Panes>(PANES_KEY, "both", [
		"editor",
		"both",
		"pdf",
	]);
	const [treeOpen, setTreeOpen] = useStored(TREE_KEY, "open", [
		"open",
		"closed",
	]);
	// An image from the file tree, shown read-only in place of the editor.
	const [preview, setPreview] = useState<string | null>(null);
	const showEditor = useCallback(
		() => setPanes((p) => (p === "pdf" ? "both" : p)),
		[setPanes],
	);

	const [mode, setMode] = useState<Mode>(savedMode);
	useEffect(() => {
		try {
			localStorage.setItem(MODE_KEY, mode);
		} catch {
			// A convenience; Rich mode is the default without it.
		}
	}, [mode]);
	// Off at the start of every session; the author ID while on.
	const [tracking, setTracking] = useState<string | null>(null);
	// null: show the panel while the file has comments or changes.
	const [reviewOpen, setReviewOpen] = useState<boolean | null>(null);
	// Off: the clean reading view, with comments and changes markup hidden.
	const [markup, setMarkup] = useState(true);
	const [commentAt, setCommentAt] = useState<{
		left: number;
		top: number;
	} | null>(null);
	const [commentError, setCommentError] = useState("");
	const [authorPrompt, setAuthorPrompt] = useState<{
		initial: Author;
		error: string;
		answer: (author: Author | null) => void;
	} | null>(null);
	const store = useMemo(createEditorStore, []);
	const {
		files: sourceFiles,
		paths: repoPaths,
		version: sourcesVersion,
	} = useProjectSources(id, project, repoState, file !== null);

	// A detached HEAD: an earlier version on screen, read-only.
	const snapshotHead = repoState?.git.branch === null ? repoState.git.head : "";
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	useEffect(() => {
		setSnapshot(null);
		if (!snapshotHead) return;
		let live = true;
		gitStatus(id).then(
			(s) => live && setSnapshot(s.snapshot),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [id, snapshotHead]);

	const isTex = file?.path.endsWith(".tex") ?? false;
	const rich = mode === "rich" && isTex;
	const openCommentRef = useRef(() => {});
	const extensions = useMemo(() => {
		const path = file?.path;
		return [
			rich && path
				? richView({
						path,
						sources: sourceFiles,
						repoFiles: repoPaths,
						figure: (p) => figureUrl(id, p),
						markup,
					})
				: [],
			editFilter(rich, markup, isTex ? tracking : null, () =>
				setNotice(
					"That edit was not tracked: a tracked change cannot go at that spot, such as inside math or a command, so it was made as a plain edit.",
				),
			),
			storeListener(store),
			Prec.high(
				keymap.of([
					{
						key: "Mod-Alt-m",
						preventDefault: true,
						run: () => {
							openCommentRef.current();
							return true;
						},
					},
				]),
			),
		];
	}, [
		file?.path,
		rich,
		markup,
		isTex,
		tracking,
		id,
		sourceFiles,
		repoPaths,
		store,
	]);
	useEffect(() => {
		if (sourcesVersion > 0)
			view.current?.dispatch({ effects: refreshRich.of(null) });
	}, [sourcesVersion]);

	/** The author for changes markup, asking once when Settings has none. */
	const getAuthor = useCallback(async (): Promise<Author | null> => {
		try {
			const s = await getSettings();
			if (s.authorId)
				return { id: s.authorId, name: s.authorName || s.authorId };
			const auth = await getAuth();
			return await new Promise((answer) =>
				setAuthorPrompt({
					initial: {
						id: auth.suggestedAuthorId,
						name: s.authorName || auth.user?.name || "",
					},
					error: "",
					answer,
				}),
			);
		} catch (error) {
			setNotice(explain(error));
			return null;
		}
	}, []);
	const saveAuthor = async (author: Author) => {
		if (!authorPrompt) return;
		try {
			const s = await getSettings();
			await putSettings({ ...s, authorId: author.id, authorName: author.name });
			setAuthorPrompt(null);
			authorPrompt.answer(author);
		} catch (error) {
			setAuthorPrompt({ ...authorPrompt, error: explain(error) });
		}
	};

	// The entry file must load `changes` and declare the author before the
	// first comment or tracked change. When the entry file is open its edits
	// go into the editor with the change (entryEdits); otherwise it is
	// loaded, fixed, and saved here.
	const prepareEntry = async (author: Author): Promise<boolean> => {
		const entry = project?.entry;
		if (!entry || entry === fileRef.current?.path) return true;
		try {
			const loaded = await loadFile(id, entry);
			const edits = ensurePreamble(loaded.text, author);
			if (edits.length > 0)
				await putFile(id, entry, loaded.hash, applyEdits(loaded.text, edits));
			return true;
		} catch (error) {
			setNotice(
				`Revisions could not add your name to ${entry}, so nothing was changed. ${explain(error)}`,
			);
			return false;
		}
	};
	const entryEdits = (text: string, author: Author): Edit[] =>
		project?.entry && project.entry === fileRef.current?.path
			? ensurePreamble(text, author)
			: [];

	const toggleTracking = async () => {
		if (snapshotHead) return;
		if (tracking) {
			setTracking(null);
			return;
		}
		const author = await getAuthor();
		if (!author || !(await prepareEntry(author))) return;
		const v = view.current;
		if (v) {
			const edits = entryEdits(v.state.doc.toString(), author);
			if (edits.length > 0) v.dispatch({ changes: edits });
			// After the author dialog, if any, has gone and released focus.
			setTimeout(() => v.focus());
		}
		setTracking(author.id);
	};

	const openComment = () => {
		const v = view.current;
		if (!fileRef.current?.path.endsWith(".tex")) return;
		if (snapshotHead) {
			setNotice(LOCKED);
			return;
		}
		if (!v || v.state.selection.main.empty) {
			setNotice("Select the text you want to comment on first.");
			return;
		}
		const sel = v.state.selection.main;
		const at = v.coordsAtPos(sel.to) ?? v.coordsAtPos(sel.from);
		const box = v.dom.getBoundingClientRect();
		setCommentError("");
		setCommentAt(
			at
				? { left: at.left, top: at.bottom }
				: { left: box.left + 40, top: box.top + 40 },
		);
	};
	openCommentRef.current = openComment;

	const submitComment = async (comment: string) => {
		const v = view.current;
		if (!v) return;
		const check = addComment(
			v.state.doc.toString(),
			v.state.selection.main,
			"X",
			comment,
		);
		if (!check.ok) {
			setCommentError(check.reason);
			return;
		}
		const author = await getAuthor();
		if (!author || !(await prepareEntry(author))) return;
		const text = v.state.doc.toString();
		const outcome = addComment(
			text,
			v.state.selection.main,
			author.id,
			comment,
		);
		if (!outcome.ok) {
			setCommentError(outcome.reason);
			return;
		}
		v.dispatch({
			changes: [...entryEdits(text, author), ...outcome.edits],
		});
		setCommentAt(null);
		setTimeout(() => v.focus());
	};

	const highlight = async () => {
		const v = view.current;
		if (!v || !fileRef.current?.path.endsWith(".tex")) return;
		const check = addHighlight(
			v.state.doc.toString(),
			v.state.selection.main,
			"X",
		);
		if (!check.ok) {
			setNotice(check.reason);
			return;
		}
		const author = await getAuthor();
		if (!author || !(await prepareEntry(author))) return;
		const text = v.state.doc.toString();
		const outcome = addHighlight(text, v.state.selection.main, author.id);
		if (!outcome.ok) {
			setNotice(outcome.reason);
			return;
		}
		v.dispatch({ changes: [...entryEdits(text, author), ...outcome.edits] });
		setTimeout(() => v.focus());
	};

	/** Opens a file, saving the current one first, and optionally jumps to a line. */
	const openFile = useCallback(
		async (path: string, jump?: Jump) => {
			const current = fileRef.current;
			if (current?.path === path) {
				if (jump && view.current)
					goToLine(view.current, jump.line, jump.column);
				return;
			}
			if (current) {
				try {
					await current.sync.flush();
				} catch {
					setNotice(
						`Your changes to ${current.path} are not saved yet, so Revisions stayed on that file.`,
					);
					return;
				}
			}
			const n = ++openCount.current;
			try {
				const sync = await openFileSync(id, path);
				if (n !== openCount.current) return;
				pendingJump.current = jump ?? null;
				setFile({ path, sync });
			} catch (error) {
				setNotice(`${path} could not be opened. ${explain(error)}`);
			}
		},
		[id],
	);

	const onEditorReady = useCallback(
		(v: EditorView) => {
			view.current = v;
			store.set(v.state);
			const jump = pendingJump.current;
			pendingJump.current = null;
			if (jump) goToLine(v, jump.line, jump.column);
		},
		[store],
	);

	useEffect(() => {
		getProject(id).then(
			(p) => {
				setProject(p);
				const first = p.entry || p.files.find((f) => f.kind === "text")?.path;
				if (first) openFile(first);
			},
			(error) => setLoadFailure(explain(error)),
		);
		getBuild(id).then(setBuild, () => {});
	}, [id, openFile]);

	// The file list, reloaded when the poll sees files come or go. A file that
	// no longer exists is left for the main document.
	const reloadProject = useCallback(() => {
		getProject(id).then(
			(p) => {
				setProject(p);
				const open = fileRef.current?.path;
				if (open && !p.files.some((f) => f.path === open)) {
					const first = p.entry || p.files.find((f) => f.kind === "text")?.path;
					if (first) openFile(first);
				}
			},
			() => {},
		);
	}, [id, openFile]);
	const tree = useRef("");

	// The disk check: every 2 s and when the window gains focus.
	const poll = useCallback(async () => {
		try {
			const state = await getState(id);
			setRepoState(state);
			if (tree.current && state.tree !== tree.current) reloadProject();
			tree.current = state.tree;
			const f = fileRef.current;
			const hash = f && state.hashes[f.path];
			if (f && hash) f.sync.diskChanged(hash);
		} catch {
			// The next poll tries again.
		}
	}, [id, reloadProject]);
	useEffect(() => {
		poll();
		const timer = setInterval(poll, 2000);
		window.addEventListener("focus", poll);
		return () => {
			clearInterval(timer);
			window.removeEventListener("focus", poll);
		};
	}, [poll]);

	// Leave-page warning while edits are not on disk.
	useEffect(() => {
		const warn = (event: BeforeUnloadEvent) => {
			if (fileRef.current?.sync.hasUnsavedWork()) event.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, []);

	// Follow a running build, and fetch the full status when the poll shows
	// that a build finished.
	const running = build?.state === "running";
	const polledBuild = repoState?.build;
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(async () => {
			const status = await getBuild(id).catch(() => null);
			if (!status) return;
			setBuild(status);
			if (status.state !== "running") poll();
		}, 1000);
		return () => clearInterval(timer);
	}, [running, id, poll]);
	const polledState = polledBuild?.state;
	const polledVersion = polledBuild?.pdfVersion;
	// biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the polled state or version changes
	useEffect(() => {
		if (polledState) getBuild(id).then(setBuild, () => {});
	}, [polledState, polledVersion, id]);

	const runBuild = useCallback(async () => {
		if (fileRef.current) {
			try {
				await fileRef.current.sync.flush();
			} catch {
				setNotice(
					"The PDF was not built because your latest changes could not be saved. See the message above the editor.",
				);
				return;
			}
		}
		try {
			setBuild(await startBuild(id));
		} catch (error) {
			if (isCode(error, "latexmk_missing")) setTexMissing(true);
			else setNotice(explain(error));
		}
	}, [id]);

	// Mod-Enter and Mod-S build. Captured before CodeMirror sees them.
	const buildRef = useRef(runBuild);
	buildRef.current = runBuild;
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey)
				return;
			if (event.key !== "Enter" && event.key.toLowerCase() !== "s") return;
			event.preventDefault();
			event.stopPropagation();
			buildRef.current();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, []);

	const showInPdf = useCallback(async () => {
		const v = view.current;
		const f = fileRef.current;
		if (!v || !f) return;
		const head = v.state.selection.main.head;
		const line = v.state.doc.lineAt(head);
		try {
			const box = await synctexForward(
				id,
				f.path,
				line.number,
				head - line.from,
			);
			if (panesRef.current === "editor") {
				setPanes("both");
				// ponytail: two frames for the pane to lay out and the pages to
				// take their new size before scrolling. Await a PdfView "ready"
				// signal instead if a slow machine misses the spot.
				await frames(2);
			}
			pdf.current?.show(box);
		} catch (error) {
			setNotice(
				isCode(error, "no_match")
					? "This line has no matching place in the PDF. Try a line of text, or build the PDF again."
					: isCode(error, "no_pdf")
						? "Build the PDF first."
						: explain(error),
			);
		}
	}, [id, setPanes]);
	const panesRef = useRef(panes);
	panesRef.current = panes;

	const showSource = useCallback(
		async (page: number, x: number, y: number) => {
			try {
				const at = await synctexInverse(id, page, x, y);
				showEditor();
				setPreview(null);
				await openFile(at.path, { line: at.line, column: at.column });
			} catch (error) {
				setNotice(
					isCode(error, "no_match")
						? "That spot in the PDF does not come from a file of this manuscript."
						: explain(error),
				);
			}
		},
		[id, openFile, showEditor],
	);

	/** Opens a file chosen in the tree, or a build error's line. */
	const openChosen = useCallback(
		(path: string, jump?: Jump) => {
			showEditor();
			setPreview(null);
			openFile(path, jump);
		},
		[openFile, showEditor],
	);
	const openFromTree = (f: ProjectFile) => {
		if (f.kind === "text") openChosen(f.path);
		else if (f.kind === "image") {
			showEditor();
			setPreview(f.path);
		} else
			setNotice(
				`${f.path} cannot be opened in Revisions. Only text files and images open here.`,
			);
	};

	// The Changes & history panel.
	const [gitOpen, setGitOpen] = useState(false);
	const gitButton = useRef<HTMLButtonElement>(null);
	const flushOpen = useCallback(async () => {
		try {
			await fileRef.current?.sync.flush();
			return true;
		} catch {
			return false;
		}
	}, []);
	// After a pull, switch, or discard: reload the file list and leave a
	// file that no longer exists.
	const afterGit = useCallback(() => {
		poll();
		reloadProject();
	}, [poll, reloadProject]);
	const openSource = useCallback(
		(path: string) => {
			setMode("source");
			openChosen(path);
		},
		[openChosen],
	);
	// Escape closes the panel when no dialog is open and nothing else used
	// the key, such as the editor's search.
	useEffect(() => {
		if (!gitOpen) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (document.querySelector("dialog[open]")) return;
			setGitOpen(false);
			gitButton.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [gitOpen]);

	const checkTex = async () => {
		const next = await getEnv();
		onEnvChange(next);
		if (next.latexmk.found) setTexMissing(false);
	};

	const chooseEntry = async (path: string) => {
		try {
			setProject(await putEntry(id, path));
		} catch (error) {
			setNotice(explain(error));
		}
	};

	if (loadFailure) {
		return (
			<main className="center">
				<section className="card">
					<h1>This manuscript cannot be opened</h1>
					<p role="alert">{loadFailure}</p>
					<a href="#/">Back to the start page</a>
				</section>
			</main>
		);
	}

	const [, owner, name] = id.split("/");
	const branch = repoState?.git.branch;
	const head = repoState?.git.head.slice(0, 7);
	const pdfVersion = Math.max(
		build?.pdfVersion ?? 0,
		polledBuild?.pdfVersion ?? 0,
	);
	const keys = mod(env.platform);
	const refusal = !isTex
		? "Comments and highlights go in LaTeX files"
		: snapshotHead
			? LOCKED
			: "";
	const showingPdf = !texMissing && pdfVersion > 0;

	return (
		<div className="project">
			<header className="topbar">
				<a className="brand" href="#/">
					Revisions
				</a>
				<button
					type="button"
					className={`quiet files-toggle ${treeOpen === "open" ? "on" : ""}`}
					aria-expanded={treeOpen === "open"}
					aria-controls="file-tree"
					onClick={() => setTreeOpen((t) => (t === "open" ? "closed" : "open"))}
					title="Show or hide the repository's files"
				>
					Files
				</button>
				<span className="repo">
					<span className="repo-name">
						{owner}/{name}
					</span>
					{repoState && (
						<span className="muted">
							{branch ? `on branch ${branch}` : `at version ${head}`}
						</span>
					)}
				</span>
				{project &&
					!project.entryFromConfig &&
					project.entryCandidates.length > 1 && (
						<label className="inline-field">
							Main document
							<select
								value={project.entry}
								onChange={(e) => chooseEntry(e.target.value)}
							>
								{project.entryCandidates.map((p) => (
									<option key={p}>{p}</option>
								))}
							</select>
						</label>
					)}
				<span className="spacer" />
				<fieldset className="segmented">
					<legend className="visually-hidden">Show</legend>
					{(
						[
							["editor", "Editor", "Show only the editor"],
							["both", "Both", "Show the editor and the PDF side by side"],
							["pdf", "PDF", "Show only the PDF"],
						] as const
					).map(([value, label, title]) => (
						<button
							key={value}
							type="button"
							aria-pressed={panes === value}
							onClick={() => setPanes(value)}
							title={title}
						>
							{label}
						</button>
					))}
				</fieldset>
				<button
					ref={gitButton}
					type="button"
					className={`quiet changes-toggle ${gitOpen ? "on" : ""}`}
					aria-expanded={gitOpen}
					onClick={() => setGitOpen((o) => !o)}
					title="Commit your changes, send them to GitHub, and see the history"
				>
					Changes &amp; history
					{repoState?.git.dirty && (
						<>
							<span className="dot" aria-hidden="true" />
							<span className="visually-hidden"> (uncommitted changes)</span>
						</>
					)}
				</button>
				{running ? (
					<span className="row">
						<span className="building" role="status">
							<span className="spinner" aria-hidden="true" /> Building the PDF…{" "}
							<Elapsed since={build?.startedAt ?? null} />
						</span>
						<button
							type="button"
							onClick={() => cancelBuild(id).then(setBuild)}
						>
							Cancel
						</button>
					</span>
				) : (
					<button
						type="button"
						className="primary"
						onClick={runBuild}
						title={`Build the PDF (${keys}Enter or ${keys}S)`}
						aria-keyshortcuts="Control+Enter Meta+Enter Control+S Meta+S"
					>
						Build PDF
					</button>
				)}
				{settings}
			</header>
			<div className="notice" role="status" aria-live="polite">
				{notice}
			</div>
			{snapshotHead && (
				<SnapshotBanner
					id={id}
					head={snapshotHead}
					snapshot={snapshot}
					onDone={afterGit}
				/>
			)}
			<div className="workspace">
				{treeOpen === "open" && project && (
					<div id="file-tree" className="sidebar">
						<FileTree
							id={id}
							files={project.files}
							entry={project.entry}
							current={preview ?? file?.path ?? ""}
							onOpen={openFromTree}
						/>
					</div>
				)}
				<Split
					both={panes === "both" || (panes === "editor" && gitOpen)}
					left={
						<section
							className="pane"
							aria-label="Editor"
							hidden={panes === "pdf"}
						>
							<div className="pane-toolbar">
								<span className="file-name" title={file?.path}>
									<bdi>{file?.path}</bdi>
								</span>
								{file && <SaveStatus sync={file.sync} />}
								<span className="spacer" />
								{isTex && (
									<fieldset className="segmented">
										<legend className="visually-hidden">View</legend>
										<button
											type="button"
											aria-pressed={mode === "rich"}
											onClick={() => setMode("rich")}
											title="Show the text formatted, like a document"
										>
											Rich text
										</button>
										<button
											type="button"
											aria-pressed={mode === "source"}
											onClick={() => setMode("source")}
											title="Show every character of the LaTeX source"
										>
											Source
										</button>
									</fieldset>
								)}
								<button
									type="button"
									className={`toggle ${tracking ? "on" : ""}`}
									aria-pressed={tracking !== null}
									onClick={toggleTracking}
									disabled={!!snapshotHead}
									title={
										snapshotHead
											? LOCKED
											: "Record your edits as suggestions others can accept or reject"
									}
								>
									<span className="switch" aria-hidden="true" />
									Track changes
								</button>
								<SelectionButton
									store={store}
									onClick={openComment}
									refusal={refusal}
									title={`Comment on the selected text (${keys}Alt+M)`}
									shortcut="Control+Alt+M Meta+Alt+M"
								>
									Comment
								</SelectionButton>
								<SelectionButton
									store={store}
									onClick={highlight}
									refusal={refusal}
									title="Highlight the selected text, without a comment"
								>
									Highlight
								</SelectionButton>
								{rich && (
									<button
										type="button"
										className={`toggle calm ${markup ? "on" : ""}`}
										aria-pressed={markup}
										onClick={() => setMarkup((on) => !on)}
										title={
											markup
												? "Hide comments and tracked changes to read the text as it would be with every change accepted"
												: "Show comments and tracked changes"
										}
									>
										<span className="switch" aria-hidden="true" />
										Markup
									</button>
								)}
								<ReviewToggle
									store={store}
									open={rich && !markup ? false : reviewOpen}
									onToggle={(open) => {
										setReviewOpen(open);
										if (open) setMarkup(true);
									}}
								/>
							</div>
							{file && <FileBanners sync={file.sync} />}
							{preview && (
								<div className="file-preview">
									<div className="file-preview-head">
										<span>
											<b>{preview}</b>{" "}
											<span className="muted">Image, read-only</span>
										</span>
										<button
											type="button"
											className="quiet"
											onClick={() => setPreview(null)}
										>
											Back to {file?.path ?? "the editor"}
										</button>
									</div>
									<FilePreview id={id} path={preview} />
								</div>
							)}
							<div className="editor-row" hidden={preview !== null}>
								{file ? (
									<Editor
										sync={file.sync}
										extensions={extensions}
										onReady={onEditorReady}
										onShowInPdf={showInPdf}
										locked={!!snapshotHead}
									/>
								) : (
									<div className="editor" />
								)}
								{file && (
									<ReviewPanel
										open={rich && !markup ? false : reviewOpen}
										store={store}
										view={() => view.current}
									/>
								)}
							</div>
							{commentAt && (
								<CommentPopover
									at={commentAt}
									error={commentError}
									onSubmit={submitComment}
									onCancel={() => {
										setCommentAt(null);
										view.current?.focus();
									}}
								/>
							)}
							{authorPrompt && (
								<AuthorDialog
									initial={authorPrompt.initial}
									error={authorPrompt.error}
									onSave={saveAuthor}
									onCancel={() => {
										authorPrompt.answer(null);
										setAuthorPrompt(null);
									}}
								/>
							)}
						</section>
					}
					right={
						<div className="right-pane" hidden={panes === "editor" && !gitOpen}>
							{gitOpen && (
								<GitPanel
									id={id}
									state={repoState}
									flush={flushOpen}
									onChanged={afterGit}
									onOpenSource={openSource}
									onAuthLost={onAuthLost}
									onClose={() => {
										setGitOpen(false);
										gitButton.current?.focus();
									}}
								/>
							)}
							<section className="pane pdf-pane" aria-label="PDF">
								<div className="pane-toolbar">
									<OutOfDate
										sync={file?.sync}
										stale={
											!running &&
											pdfVersion > 0 &&
											(polledBuild?.stale ?? false)
										}
										keys={keys}
									/>
									<span className="spacer" />
									{showingPdf && (
										<button
											type="button"
											className="quiet"
											onClick={showInPdf}
											title={`Scroll the PDF to the cursor's place in the editor (${keys}J)`}
											aria-keyshortcuts="Control+J Meta+J"
										>
											Show in PDF
										</button>
									)}
									{showingPdf && <BuildLogButton id={id} />}
									{showingPdf && (
										<span className="row zoom">
											<button
												type="button"
												aria-label="Zoom out"
												onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
											>
												−
											</button>
											<button
												type="button"
												aria-label={`${Math.round(zoom * 100)}%, fit to width`}
												title="Fit to width"
												onClick={() => setZoom(1)}
											>
												{Math.round(zoom * 100)}%
											</button>
											<button
												type="button"
												aria-label="Zoom in"
												onClick={() => setZoom((z) => Math.min(4, z * 1.25))}
											>
												+
											</button>
										</span>
									)}
								</div>
								{running && <div className="progress" aria-hidden="true" />}
								{build && <BuildProblems build={build} onOpen={openChosen} />}
								{texMissing ? (
									<div className="pdf-empty">
										<TexGuidance platform={env.platform} onCheck={checkTex} />
									</div>
								) : showingPdf ? (
									<PdfView
										ref={pdf}
										id={id}
										version={pdfVersion}
										zoom={zoom}
										onInverse={showSource}
									/>
								) : (
									<div className="pdf-empty">
										<p className="muted">
											{running
												? "Building the PDF for the first time…"
												: `No PDF yet. Press Build PDF (${keys}Enter) to see the manuscript here.`}
										</p>
									</div>
								)}
							</section>
						</div>
					}
				/>
			</div>
		</div>
	);
}

/** Says which earlier version is on screen, and leads back to a branch. */
function SnapshotBanner({
	id,
	head,
	snapshot,
	onDone,
}: {
	id: RepoId;
	head: string;
	/** null until the status arrives. */
	snapshot: Snapshot | null;
	/** Called after the checkout moved. */
	onDone: () => void;
}) {
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (naming) input.current?.focus();
	}, [naming]);
	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setProblem("");
		try {
			await action();
			onDone();
		} catch (error) {
			setProblem(explain(error));
		} finally {
			setBusy(false);
		}
	};
	const back = snapshot?.returnTo;
	return (
		<section
			className="banner warn snapshot-banner"
			aria-label="Earlier version"
		>
			<p>
				<b>You are looking at an earlier version</b>
				{snapshot ? (
					<>
						: “{snapshot.subject}”, from{" "}
						<time dateTime={snapshot.date}>
							{new Date(snapshot.date).toLocaleString(undefined, {
								dateStyle: "long",
								timeStyle: "short",
							})}
						</time>
						.
					</>
				) : (
					` (${head.slice(0, 7)}).`
				)}{" "}
				It cannot be changed here. To edit from this version, start a branch
				from it.
			</p>
			{naming ? (
				<form
					className="row"
					onSubmit={(e) => {
						e.preventDefault();
						run(() => gitCreateBranch(id, name.trim()));
					}}
				>
					<label className="inline-field">
						Branch name
						<input
							ref={input}
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							spellCheck={false}
							placeholder="for example, gale-edits"
						/>
					</label>
					<button type="submit" className="primary" disabled={busy}>
						Create branch
					</button>
					<button type="button" onClick={() => setNaming(false)}>
						Cancel
					</button>
				</form>
			) : (
				<div className="row">
					{back && (
						<button
							type="button"
							className="primary"
							disabled={busy}
							onClick={() => run(() => gitCheckout(id, back))}
						>
							Back to {back}
						</button>
					)}
					<button
						type="button"
						disabled={busy}
						onClick={() => setNaming(true)}
						title="A new branch starts at this version, and you can edit it"
					>
						Start a branch from this version
					</button>
				</div>
			)}
			{problem && (
				<p role="alert" className="alert">
					{problem}
				</p>
			)}
		</section>
	);
}

/** Whole seconds since `since`, counting up while shown. */
function Elapsed({ since }: { since: string | null }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	if (!since) return null;
	const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
	return <span className="elapsed">{seconds} s</span>;
}

function useSyncState(sync: FileSync) {
	return useSyncExternalStore(sync.subscribe, sync.getState);
}

const statusText: Record<SyncStatus, string> = {
	saved: "Saved",
	saving: "Saving…",
	unsaved: "Unsaved",
	"read-only": "Read-only",
	collision: "Not saved",
	error: "Not saved",
};

function SaveStatus({ sync }: { sync: FileSync }) {
	const { status } = useSyncState(sync);
	return (
		<span className={`save-status ${status}`} role="status" aria-live="polite">
			{statusText[status]}
		</span>
	);
}

/** Collision, save failure, and read-only notices above the editor. */
function FileBanners({ sync }: { sync: FileSync }) {
	const state = useSyncState(sync);
	const [copied, setCopied] = useState(false);
	const [failure, setFailure] = useState("");
	if (state.status === "collision") {
		return (
			<div role="alert" className="banner danger">
				<p>
					<b>Your latest changes were not saved.</b> This file was changed on
					disk by something else while you were editing. Copy your text below if
					you need it, then reload the file to see what is on disk.
				</p>
				<textarea
					readOnly
					value={state.text}
					aria-label="Your unsaved text"
					rows={5}
				/>
				<div className="row">
					<button
						type="button"
						onClick={() =>
							navigator.clipboard
								.writeText(state.text)
								.then(() => setCopied(true))
						}
					>
						{copied ? "Copied" : "Copy"}
					</button>
					<button
						type="button"
						className="primary"
						onClick={() =>
							sync.reload().then(
								() => setCopied(false),
								(error) => setFailure(explain(error)),
							)
						}
					>
						Reload
					</button>
					{failure && <span>{failure}</span>}
				</div>
			</div>
		);
	}
	if (state.status === "error") {
		return (
			<div role="alert" className="banner danger">
				<p>
					Your changes could not be saved. {state.error} Revisions tries again
					after your next change.
				</p>
				<button type="button" onClick={() => sync.flush().catch(() => {})}>
					Try again now
				</button>
			</div>
		);
	}
	if (state.status === "read-only") {
		return (
			<div className="banner">
				This file is not plain text in the UTF-8 encoding, so Revisions shows it
				but cannot change it.
			</div>
		);
	}
	return null;
}

/** The out-of-date warning: the PDF lags the files or the editor. */
function OutOfDate({
	sync,
	stale,
	keys,
}: {
	sync: FileSync | undefined;
	stale: boolean;
	keys: string;
}) {
	const unsaved = useSyncExternalStore(
		(listener) => sync?.subscribe(listener) ?? (() => {}),
		() => sync?.hasUnsavedWork() ?? false,
	);
	if (!stale && !(unsaved && sync)) return null;
	return (
		<span className="badge warn">
			The PDF is out of date. Build it ({keys}Enter) to see your changes.
		</span>
	);
}

const problemTitle: Partial<Record<BuildStatus["state"], string>> = {
	failed: "The PDF could not be built",
	timeout:
		"The build took longer than the time limit in Settings and was stopped",
	canceled: "The build was cancelled",
};

function BuildProblems({
	build,
	onOpen,
}: {
	build: BuildStatus;
	onOpen: (path: string, jump: Jump) => void;
}) {
	const title = problemTitle[build.state];
	if (!title) return null;
	return (
		<div className="build-problems" role="alert">
			<h2>{title}</h2>
			<p className="muted">
				{build.pdfVersion > 0
					? "The last PDF that built is still shown below."
					: "No PDF has been built yet."}
				{build.errors.length > 0 && " Click a problem to go to that line."}
			</p>
			{build.errors.length > 0 && (
				<ul>
					{build.errors.map((e, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the list is replaced whole
						<li key={i}>
							{e.path ? (
								<button
									type="button"
									className="link"
									onClick={() => onOpen(e.path, { line: e.line, column: 0 })}
								>
									<span className="where">
										{e.path}, line {e.line}:
									</span>{" "}
									{e.message}
								</button>
							) : (
								<span>{e.message}</span>
							)}
						</li>
					))}
				</ul>
			)}
			<details>
				<summary>Full build log</summary>
				<pre>{build.log}</pre>
			</details>
		</div>
	);
}

/** The log of the build whose PDF is on screen, in a dialog. */
function BuildLogButton({ id }: { id: RepoId }) {
	const [shown, setShown] = useState<{ log: string; builtAt: string } | null>(
		null,
	);
	const [failure, setFailure] = useState("");
	const [copied, setCopied] = useState(false);
	const open = async () => {
		setCopied(false);
		try {
			setShown(await getPdfLog(id));
			setFailure("");
		} catch (error) {
			setShown({ log: "", builtAt: "" });
			setFailure(explain(error));
		}
	};
	return (
		<>
			<button
				type="button"
				className="quiet"
				onClick={open}
				title="The output of the build that made the PDF shown here"
			>
				Build log
			</button>
			{shown && (
				<Modal
					title="Log of the PDF on screen"
					wide
					onClose={() => setShown(null)}
				>
					{failure ? (
						<p role="alert" className="alert">
							{failure}
						</p>
					) : (
						<p className="muted">
							Built {new Date(shown.builtAt).toLocaleString()}. A later build
							that failed is not shown here; its log is with its error above the
							PDF.
						</p>
					)}
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus so the keyboard can scroll it */}
					<section className="build-log" aria-label="Build log" tabIndex={0}>
						<pre>{shown.log}</pre>
					</section>
					<div className="row end">
						<button
							type="button"
							onClick={() =>
								navigator.clipboard
									.writeText(shown.log)
									.then(() => setCopied(true))
							}
						>
							{copied ? "Copied" : "Copy"}
						</button>
						<button
							type="button"
							className="primary"
							onClick={() => setShown(null)}
						>
							Close
						</button>
					</div>
				</Modal>
			)}
		</>
	);
}

const SPLIT_KEY = "revisions.split";

/** Two panes with a draggable divider. The position is a per-viewer
 * convenience kept in localStorage. With `both` false one pane, the other
 * `hidden`, takes the whole width. */
function Split({
	left,
	right,
	both,
}: {
	left: ReactNode;
	right: ReactNode;
	both: boolean;
}) {
	const [fraction, setFraction] = useState(() => {
		try {
			const saved = Number(localStorage.getItem(SPLIT_KEY));
			return saved >= 0.2 && saved <= 0.8 ? saved : 0.5;
		} catch {
			return 0.5;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(SPLIT_KEY, String(fraction));
		} catch {
			// Storage is a convenience; the split still works without it.
		}
	}, [fraction]);
	const clamp = (f: number) => Math.min(0.8, Math.max(0.2, f));

	const drag = (event: PointerEvent<HTMLDivElement>) => {
		const divider = event.currentTarget;
		const box = divider.parentElement?.getBoundingClientRect();
		if (!box) return;
		divider.setPointerCapture(event.pointerId);
		const move = (e: globalThis.PointerEvent) =>
			setFraction(clamp((e.clientX - box.left) / box.width));
		const up = () => {
			divider.removeEventListener("pointermove", move);
			divider.removeEventListener("pointerup", up);
		};
		divider.addEventListener("pointermove", move);
		divider.addEventListener("pointerup", up);
	};
	const key = (event: KeyboardEvent<HTMLDivElement>) => {
		const step =
			event.key === "ArrowLeft" ? -0.05 : event.key === "ArrowRight" ? 0.05 : 0;
		if (step) {
			event.preventDefault();
			setFraction((f) => clamp(f + step));
		}
	};

	return (
		<div
			className="split"
			style={{
				gridTemplateColumns: both
					? `minmax(0, ${fraction}fr) auto minmax(0, ${1 - fraction}fr)`
					: "minmax(0, 1fr)",
			}}
		>
			{left}
			{/* biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter; <hr> cannot take focus */}
			<div
				className="divider"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize the editor and the PDF"
				aria-valuemin={20}
				aria-valuemax={80}
				aria-valuenow={Math.round(fraction * 100)}
				tabIndex={0}
				onPointerDown={drag}
				onKeyDown={key}
				hidden={!both}
			/>
			{right}
		</div>
	);
}

type Panes = "editor" | "both" | "pdf";
const PANES_KEY = "revisions.panes";
const TREE_KEY = "revisions.files";

/** A per-viewer choice among `values`, kept in localStorage. */
function useStored<T extends string>(
	key: string,
	initial: T,
	values: readonly T[],
) {
	const [value, setValue] = useState<T>(() => {
		try {
			const saved = localStorage.getItem(key) as T | null;
			return saved && values.includes(saved) ? saved : initial;
		} catch {
			return initial;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(key, value);
		} catch {
			// A convenience; the default applies without it.
		}
	}, [key, value]);
	return [value, setValue] as const;
}

const frames = async (n: number) => {
	for (let i = 0; i < n; i++)
		await new Promise((r) => requestAnimationFrame(r));
};

/** An image from the repository, read-only. */
function FilePreview({ id, path }: { id: RepoId; path: string }) {
	const [url, setUrl] = useState("");
	const [failure, setFailure] = useState("");
	useEffect(() => {
		setUrl("");
		setFailure("");
		figureUrl(id, path).then(setUrl, (error) => setFailure(explain(error)));
	}, [id, path]);
	if (failure)
		return (
			<p role="alert" className="alert">
				{path} cannot be shown. {failure}
			</p>
		);
	return url ? <img src={url} alt={path} /> : null;
}

type Mode = "rich" | "source";
const MODE_KEY = "revisions.mode";

function savedMode(): Mode {
	try {
		return localStorage.getItem(MODE_KEY) === "source" ? "source" : "rich";
	} catch {
		return "rich";
	}
}

/**
 * Every `.tex` and `.bib` file of the project, loaded in parallel once the
 * open file shows (so its text is not queued behind them) and reloaded when
 * the poll shows a hash changed, so citations and references resolve across
 * files without a build. `files` and `paths` are stable; `version` counts
 * the updates.
 */
function useProjectSources(
	id: RepoId,
	project: Project | null,
	repoState: RepoState | null,
	opened: boolean,
) {
	const loaded = useRef(new Map<string, { hash: string; text: string }>());
	const loading = useRef(new Set<string>());
	const all = useRef<ReadonlySet<string>>(new Set());
	const [version, setVersion] = useState(0);
	useEffect(() => {
		if (!project) return;
		all.current = new Set(project.files.map((f) => f.path));
		if (!opened) return;
		const hashes = repoState?.hashes ?? {};
		const stale = project.files
			.filter(
				(f) =>
					f.kind === "text" &&
					/\.(tex|bib)$/.test(f.path) &&
					!loading.current.has(f.path),
			)
			.map((f) => f.path)
			.filter((p) => {
				const have = loaded.current.get(p);
				return !have || (hashes[p] !== undefined && hashes[p] !== have.hash);
			});
		if (stale.length === 0) return;
		for (const p of stale) loading.current.add(p);
		Promise.allSettled(
			stale.map(async (p) => {
				try {
					const f = await loadFile(id, p);
					loaded.current.set(p, { hash: f.hash, text: f.text });
				} finally {
					loading.current.delete(p);
				}
			}),
		).then(() => setVersion((v) => v + 1));
	}, [id, project, repoState, opened]);
	const files = useCallback(
		(): SourceFile[] =>
			[...loaded.current].map(([path, f]) => ({ path, text: f.text })),
		[],
	);
	const paths = useCallback(() => all.current, []);
	return { files, paths, version };
}

/** A toolbar button that acts on the editor's selection: Comment, Highlight. */
function SelectionButton({
	store,
	onClick,
	refusal,
	title,
	shortcut,
	children,
}: {
	store: EditorStore;
	onClick: () => void;
	/** Why the button cannot be used here, such as in a .bib file; "" when it can. */
	refusal: string;
	title: string;
	shortcut?: string;
	children: ReactNode;
}) {
	const state = useEditorState(store);
	const empty = !!refusal || (state?.selection.main.empty ?? true);
	return (
		<button
			type="button"
			className="quiet"
			onClick={onClick}
			disabled={empty}
			title={refusal ? refusal : empty ? "Select text first" : title}
			aria-keyshortcuts={shortcut}
		>
			{children}
		</button>
	);
}

function ReviewToggle({
	store,
	open,
	onToggle,
}: {
	store: EditorStore;
	open: boolean | null;
	onToggle: (open: boolean) => void;
}) {
	const state = useEditorState(store);
	const count = state ? changesIn(state).length : 0;
	const shown = open ?? count > 0;
	return (
		<button
			type="button"
			className="quiet"
			aria-expanded={shown}
			onClick={() => onToggle(!shown)}
			title={shown ? "Hide comments and changes" : "Show comments and changes"}
		>
			Review <span className="count">{count}</span>
		</button>
	);
}
