// Source-mode colouring. Which spans get which colour is core's decision
// (sourceTokens); this file only turns the spans into CodeMirror marks.
import { RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { type SourceToken, sourceTokens } from "../core/latex/tokens";

const marks: Record<SourceToken["type"], Decoration> = {
	command: Decoration.mark({ class: "tok-command" }),
	comment: Decoration.mark({ class: "tok-comment" }),
	math: Decoration.mark({ class: "tok-math" }),
	brace: Decoration.mark({ class: "tok-brace" }),
	environment: Decoration.mark({ class: "tok-environment" }),
};

// ponytail: rescans the whole document on every change. Core memoises the
// scan and manuscripts are small; limit it to the viewport if typing lags.
function build(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	for (const token of sourceTokens(view.state.doc.toString())) {
		if (token.to > token.from)
			builder.add(token.from, token.to, marks[token.type]);
	}
	return builder.finish();
}

export const sourceHighlight = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = build(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged) this.decorations = build(update.view);
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);
