import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
	highlightSelectionMatches,
	search,
	searchKeymap,
} from "@codemirror/search";
import {
	Compartment,
	EditorState,
	type Extension,
	Transaction,
} from "@codemirror/state";
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { FileSync } from "../core/sync/sync";
import { sourceHighlight } from "./highlight";

export interface EditorProps {
	/** The open file. The document is always its exact text. */
	sync: FileSync;
	/**
	 * Extra CodeMirror extensions, such as rich decorations or a
	 * tracked-change filter. Pass a stable array: a new array reconfigures.
	 */
	extensions?: readonly Extension[];
	/** Called with the view once it exists, for commands from outside. */
	onReady?: (view: EditorView) => void;
	/** Mod-J: show the cursor's location in the PDF. */
	onShowInPdf?: () => void;
	/**
	 * Refuse every change but reloads from disk, while the cursor still
	 * moves and selects: an earlier version shown as a snapshot.
	 */
	locked?: boolean;
}

const none: readonly Extension[] = [];

const readOnly = (on: boolean, locked: boolean) => [
	EditorState.readOnly.of(on || locked),
	EditorView.editable.of(!on),
	// Comments, accept and reject dispatch changes that readOnly lets through.
	locked
		? EditorState.transactionFilter.of((tr) =>
				tr.docChanged && !tr.annotation(Transaction.remote) ? [] : tr,
			)
		: [],
];

/** Replaces the document with `text`, changing only the range that differs so
 * the cursor and scroll position stay where they were. Not undoable. */
function replaceDoc(view: EditorView, text: string) {
	const old = view.state.doc.toString();
	const max = Math.min(old.length, text.length);
	let from = 0;
	while (from < max && old.charCodeAt(from) === text.charCodeAt(from)) from++;
	let end = 0;
	while (
		end < max - from &&
		old.charCodeAt(old.length - 1 - end) ===
			text.charCodeAt(text.length - 1 - end)
	) {
		end++;
	}
	view.dispatch({
		changes: {
			from,
			to: old.length - end,
			insert: text.slice(from, text.length - end),
		},
		annotations: [
			Transaction.addToHistory.of(false),
			Transaction.remote.of(true),
		],
	});
}

/** Puts the cursor at a 1-based line and 0-based column, centred in view. */
export function goToLine(view: EditorView, line: number, column = 0) {
	const doc = view.state.doc;
	const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
	const pos = Math.min(target.from + column, target.to);
	view.dispatch({
		selection: { anchor: pos },
		effects: EditorView.scrollIntoView(pos, { y: "center" }),
	});
	view.focus();
}

/** One CodeMirror view over one open file, in Source mode. */
export function Editor({
	sync,
	extensions = none,
	onReady,
	onShowInPdf,
	locked = false,
}: EditorProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const compartments = useRef({
		readOnly: new Compartment(),
		extra: new Compartment(),
	});
	const callbacks = useRef({ onReady, onShowInPdf });
	callbacks.current = { onReady, onShowInPdf };
	const isReadOnly = useSyncExternalStore(
		sync.subscribe,
		() => sync.getState().status === "read-only",
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the view is made once per file; later changes to extensions and read-only arrive through the compartments below.
	useEffect(() => {
		if (!host.current) return;
		const { readOnly: ro, extra } = compartments.current;
		const initial = sync.getState();
		let loadCount = initial.loadCount;
		const v = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: initial.text,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightActiveLine(),
					history(),
					drawSelection(),
					search({ top: true, literal: true }),
					highlightSelectionMatches(),
					EditorView.lineWrapping,
					sourceHighlight,
					keymap.of([
						{
							key: "Mod-j",
							preventDefault: true,
							run: () => {
								callbacks.current.onShowInPdf?.();
								return true;
							},
						},
						...searchKeymap,
						...historyKeymap,
						...defaultKeymap,
					]),
					EditorView.contentAttributes.of({ "aria-label": "Source" }),
					ro.of(readOnly(initial.status === "read-only", locked)),
					extra.of(extensions),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) sync.edit(update.state.doc.toString());
					}),
				],
			}),
		});
		view.current = v;
		// A reload from disk replaces the document; echoing it back through
		// sync.edit is a no-op because the text matches.
		const unsubscribe = sync.subscribe(() => {
			const state = sync.getState();
			if (state.loadCount === loadCount) return;
			loadCount = state.loadCount;
			replaceDoc(v, state.text);
		});
		callbacks.current.onReady?.(v);
		return () => {
			unsubscribe();
			v.destroy();
			view.current = null;
		};
	}, [sync]);

	useEffect(() => {
		view.current?.dispatch({
			effects: compartments.current.readOnly.reconfigure(
				readOnly(isReadOnly, locked),
			),
		});
	}, [isReadOnly, locked]);

	useEffect(() => {
		view.current?.dispatch({
			effects: compartments.current.extra.reconfigure(extensions),
		});
	}, [extensions]);

	return <div ref={host} className="editor" />;
}
