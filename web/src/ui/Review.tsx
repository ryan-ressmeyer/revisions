// Comments and tracked changes: the review panel, the comment popover, and
// the one-time author dialog.
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import {
	acceptAll,
	acceptChange,
	type Edit,
	rejectAll,
	rejectChange,
	resolveComment,
	unescapeComment,
} from "../core/changes/changes";
import { type Change, findChanges } from "../core/latex/changes";
import { authorColours } from "./rich";

/** The latest editor state, for React components outside the editor. */
export interface EditorStore {
	get(): EditorState | null;
	set(state: EditorState): void;
	subscribe(listener: () => void): () => void;
}

export function createEditorStore(): EditorStore {
	let state: EditorState | null = null;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set(next) {
			if (state && state.doc === next.doc && state.selection.eq(next.selection))
				return;
			state = next;
			for (const l of listeners) l();
		},
		subscribe(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
	};
}

/** Keeps `store` up to date with the editor's document and selection. */
export function storeListener(store: EditorStore): Extension {
	return EditorView.updateListener.of((u) => store.set(u.state));
}

export function useEditorState(store: EditorStore) {
	return useSyncExternalStore(store.subscribe, store.get);
}

// Memoised per document, which is immutable.
const changesOf = new WeakMap<object, Change[]>();
export function changesIn(state: EditorState): Change[] {
	let list = changesOf.get(state.doc);
	if (!list) {
		list = findChanges(state.doc.toString());
		changesOf.set(state.doc, list);
	}
	return list;
}

const kindLabel: Record<Change["kind"], string> = {
	added: "Inserted",
	deleted: "Deleted",
	replaced: "Replaced",
	highlight: "Comment",
	comment: "Note",
};

const tracked = (c: Change) =>
	c.kind === "added" || c.kind === "deleted" || c.kind === "replaced";

function snippet(text: string): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

/** The side panel listing the open file's comments and tracked changes. */
export function ReviewPanel({
	open,
	store,
	view,
}: {
	/** `null` shows the panel only while there is something in it. */
	open: boolean | null;
	store: EditorStore;
	view: () => EditorView | null;
}) {
	const state = useEditorState(store);
	if (!state) return null;
	const changes = changesIn(state);
	if (!(open ?? changes.length > 0)) return null;
	const doc = state.doc;
	const head = state.selection.main.head;
	const current = changes.findLast((c) => c.from <= head && head <= c.to);
	const anyTracked = changes.some(tracked);
	const colour = authorColours(changes);

	// Every action is an ordinary transaction on the state it was computed
	// from, so undo works and a stale click does nothing.
	const apply = (edits: Edit[]) => {
		const v = view();
		if (!v || v.state.doc !== doc || edits.length === 0) return;
		v.dispatch({ changes: edits });
	};
	const show = (c: Change) => {
		const v = view();
		if (!v || v.state.doc !== doc) return;
		v.dispatch({
			selection: { anchor: c.text.from, head: c.text.to },
			effects: EditorView.scrollIntoView(c.text.from, { y: "center" }),
		});
		v.focus();
	};

	return (
		<aside className="review" aria-label="Review">
			<div className="review-head">
				<h2>Comments and changes</h2>
				<div className="row">
					<button
						type="button"
						disabled={!anyTracked}
						onClick={() => apply(acceptAll(doc.toString()))}
					>
						Accept all
					</button>
					<button
						type="button"
						disabled={!anyTracked}
						onClick={() => apply(rejectAll(doc.toString()))}
					>
						Reject all
					</button>
				</div>
			</div>
			{changes.length === 0 ? (
				<p className="muted review-empty">
					No comments or tracked changes in this file. Select text and press
					Comment, or turn on Track changes.
				</p>
			) : (
				<ul>
					{changes.map((c) => {
						const text = doc.sliceString(c.text.from, c.text.to);
						const old = c.old && doc.sliceString(c.old.from, c.old.to);
						return (
							<li
								key={`${c.from}-${c.kind}`}
								className={`review-item ${c === current ? "current" : ""}`}
								aria-current={c === current ? "true" : undefined}
							>
								<div className="review-meta">
									<span
										className={`author-dot ${colour(c.author ?? "")}`}
										aria-hidden="true"
									/>
									<b>{c.author ?? "Unknown"}</b>
									<span className="muted">
										{c.kind === "highlight" && c.comment === undefined
											? "Highlight"
											: kindLabel[c.kind]}
									</span>
								</div>
								<button
									type="button"
									className={`link review-snippet kind-${c.kind}`}
									onClick={() => show(c)}
									title="Show in the text"
								>
									{old !== undefined ? (
										<>
											<del>{snippet(old)}</del> → <ins>{snippet(text)}</ins>
										</>
									) : c.kind === "added" ? (
										<ins>{snippet(text)}</ins>
									) : c.kind === "deleted" ? (
										<del>{snippet(text)}</del>
									) : (
										<q>{snippet(text)}</q>
									)}
								</button>
								{c.comment !== undefined && (
									<p className="review-comment">{unescapeComment(c.comment)}</p>
								)}
								<div className="row">
									{tracked(c) ? (
										<>
											<button
												type="button"
												onClick={() => apply(acceptChange(c))}
											>
												Accept
											</button>
											<button
												type="button"
												onClick={() => apply(rejectChange(c))}
											>
												Reject
											</button>
										</>
									) : (
										<button
											type="button"
											onClick={() => apply(resolveComment(c))}
										>
											{c.comment === undefined && c.kind === "highlight"
												? "Remove"
												: "Resolve"}
										</button>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}

/** The small form that asks for a comment's text. */
export function CommentPopover({
	at,
	error,
	onSubmit,
	onCancel,
}: {
	/** Viewport coordinates to place the popover below. */
	at: { left: number; top: number };
	error: string;
	onSubmit: (comment: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);
	useEffect(() => box.current?.focus(), []);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		onSubmit(text);
	};
	const key = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onCancel();
		} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			onSubmit(text);
		}
	};
	const left = Math.max(8, Math.min(at.left, window.innerWidth - 340));
	const top = Math.min(at.top + 6, window.innerHeight - 220);
	return (
		<form
			className="popover comment-popover"
			style={{ left, top }}
			onSubmit={submit}
			onKeyDown={key}
			aria-label="New comment"
		>
			<label htmlFor="comment-text">Your comment</label>
			<textarea
				id="comment-text"
				ref={box}
				rows={3}
				value={text}
				onChange={(e) => setText(e.target.value)}
			/>
			{error && (
				<p role="alert" className="popover-error">
					{error}
				</p>
			)}
			<div className="row end">
				<button type="button" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" className="primary">
					Add comment
				</button>
			</div>
		</form>
	);
}

export interface Author {
	id: string;
	name: string;
}

/** Asks once for the author ID that marks this user's comments and changes. */
export function AuthorDialog({
	initial,
	error,
	onSave,
	onCancel,
}: {
	initial: Author;
	error: string;
	onSave: (author: Author) => void;
	onCancel: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [form, setForm] = useState(initial);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	return (
		<dialog
			ref={dialog}
			aria-labelledby="author-title"
			onCancel={(e) => {
				e.preventDefault();
				onCancel();
			}}
		>
			<form
				className="settings"
				onSubmit={(e) => {
					e.preventDefault();
					onSave(form);
				}}
			>
				<h2 id="author-title">Who are you?</h2>
				<p className="muted">
					Your comments and tracked changes are marked with your initials, so
					your co-authors can see who wrote them. You can change this later in
					Settings.
				</p>
				<label>
					Author ID
					<input
						value={form.id}
						required
						pattern="[A-Za-z0-9]+"
						title="Letters and digits only"
						onChange={(e) => setForm({ ...form, id: e.target.value })}
					/>
				</label>
				<label>
					Your name
					<input
						value={form.name}
						onChange={(e) => setForm({ ...form, name: e.target.value })}
					/>
				</label>
				{error && (
					<p role="alert" className="alert">
						{error}
					</p>
				)}
				<div className="row end">
					<button type="button" onClick={onCancel}>
						Cancel
					</button>
					<button type="submit" className="primary">
						Save
					</button>
				</div>
			</form>
		</dialog>
	);
}
