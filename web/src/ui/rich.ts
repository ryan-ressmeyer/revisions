// Rich mode: core's render plan as CodeMirror decorations. Which ranges hide,
// style, or become widgets is core's decision (buildPlan, revealSelection);
// this file only draws them.
import {
	type EditorState,
	type Extension,
	type Range,
	StateEffect,
	StateField,
} from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	WidgetType,
} from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { unescapeComment } from "../core/changes/changes";
import {
	buildPlan,
	type CiteWidget,
	type Fragment,
	type Plan,
	type Primitive,
	type RefWidget,
	revealSelection,
	type ValueWidget,
	type Widget,
} from "../core/latex/plan";
import {
	buildIndex,
	definedMacros,
	type ProjectIndex,
	resolveGraphicsPath,
	type SourceFile,
} from "../core/latex/project";

export interface RichConfig {
	/** The open file's repository path. */
	path: string;
	/** The project's entry file, or "" when it has none. */
	entry: string;
	/** The project's other `.tex` and `.bib` files, as last loaded. */
	sources: () => readonly SourceFile[];
	/** Every file path in the repository. */
	repoFiles: () => ReadonlySet<string>;
	/** A URL for an image of a repository file, or a rejection. */
	figure: (path: string) => Promise<string>;
	/** Show comments and changes markup; false is the clean reading view. */
	markup: boolean;
}

/** Dispatch after `sources` or `repoFiles` change to re-render. */
export const refreshRich = StateEffect.define<null>();

interface RichState {
	plan: Plan;
	index: ProjectIndex;
	decorations: DecorationSet;
	atomic: DecorationSet;
	/** Whether the preamble shows: once the selection moves into it, not at load. */
	open: boolean;
}

/** Rich mode for one open `.tex` file. */
export function richView(config: RichConfig): Extension {
	const planOf = (state: EditorState) => {
		const text = state.doc.toString();
		const index = buildIndex([
			...config.sources().filter((f) => f.path !== config.path),
			{ path: config.path, text },
		]);
		const macros = definedMacros(index, config.entry, config.path);
		return {
			plan: buildPlan(text, index, { markup: config.markup, macros }),
			index,
		};
	};
	const field = StateField.define<RichState>({
		create(state) {
			const { plan, index } = planOf(state);
			return {
				plan,
				index,
				open: false,
				...decorate(plan, index, state, false, config),
			};
		},
		update(value, tr) {
			const open = tr.selection
				? tr.state.selection.ranges.some((r) => r.from < value.plan.bodyStart)
				: value.open;
			if (tr.docChanged || tr.effects.some((e) => e.is(refreshRich))) {
				const { plan, index } = planOf(tr.state);
				return {
					plan,
					index,
					open,
					...decorate(plan, index, tr.state, open, config),
				};
			}
			if (!tr.selection) return value;
			return {
				...value,
				open,
				...decorate(value.plan, value.index, tr.state, open, config),
			};
		},
		provide: (f) => [
			EditorView.decorations.from(f, (v) => v.decorations),
			EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
		],
	});
	return [field, EditorView.editorAttributes.of({ class: "rich" })];
}

function decorate(
	plan: Plan,
	index: ProjectIndex,
	state: EditorState,
	open: boolean,
	config: RichConfig,
): { decorations: DecorationSet; atomic: DecorationSet } {
	const ranges = state.selection.ranges;
	const shown = revealSelection(plan, ranges);
	const out: Range<Decoration>[] = [];
	const atomic: Range<Decoration>[] = [];
	const colour = authorColours(plan.changes);
	for (const p of shown.primitives) {
		// One Decoration per primitive for the plan's lifetime, so a cursor
		// move only refilters the plan instead of rebuilding every widget.
		let d = made.get(p);
		if (!d) {
			d = decoration(p, index, colour, config);
			if (d) made.set(p, d);
		}
		if (!d) continue;
		out.push(d.range(p.from, p.to));
		if (p.type === "hide" || p.type === "widget")
			atomic.push(d.range(p.from, p.to));
	}
	// The preamble folds into one row while the selection is outside it.
	const start = plan.bodyStart;
	if (start > 0 && !open) {
		const block =
			start === state.doc.length ||
			state.doc.sliceString(start, start + 1) === "\n";
		out.push(
			Decoration.replace({ widget: new PreambleWidget(), block }).range(
				0,
				start,
			),
		);
	}
	return {
		decorations: Decoration.set(out, true),
		atomic: Decoration.set(atomic, true),
	};
}

const made = new WeakMap<Primitive, Decoration>();
const hidden = Decoration.replace({});

function decoration(
	p: Primitive,
	index: ProjectIndex,
	colour: (author: string) => string,
	config: RichConfig,
): Decoration | undefined {
	switch (p.type) {
		case "hide":
			return hidden;
		case "line":
			return Decoration.line({
				class: "rich-list",
				attributes: { style: `--depth: ${p.attrs.depth}` },
			});
		case "mark":
			return markOf(p.class, p.attrs, colour);
		case "widget": {
			const w = p.widget;
			if (w.kind === "image") {
				const resolved = resolveGraphicsPath(
					w.path,
					config.path,
					config.repoFiles(),
					index.graphicsPaths,
				);
				if (resolved) prefetch(resolved, config.figure);
				return Decoration.replace({
					widget: new FigureWidget(w.path, resolved, config.figure),
					block: p.block,
				});
			}
			return Decoration.replace({ widget: new PlanWidget(w), block: p.block });
		}
	}
}

const kindTitle: Record<string, string> = {
	added: "Inserted",
	deleted: "Deleted",
	replaced: "Replaced",
	highlight: "Comment",
	comment: "Note",
};

function markOf(
	cls: string,
	attrs: Record<string, string> | undefined,
	colour: (author: string) => string,
): Decoration {
	if (cls === "heading") {
		return Decoration.mark({
			class: `rich-heading rich-h${attrs?.level ?? "2"}`,
		});
	}
	if (!attrs?.change) {
		return Decoration.mark({ class: `rich-${cls}` });
	}
	const author = attrs.author ?? "";
	const kind =
		attrs.change === "highlight" && attrs.comment === undefined
			? "Highlight"
			: (kindTitle[attrs.change] ?? "Change");
	let title = `${kind}${author ? ` by ${author}` : ""}`;
	if (attrs.comment !== undefined)
		title += `: ${unescapeComment(attrs.comment)}`;
	return Decoration.mark({
		class: `rich-${cls} ${colour(author)}${cls === "deleted" && attrs.change === "replaced" ? " old" : ""}`,
		attributes: { title },
	});
}

/**
 * The colour class (`author-0` to `author-7`) of each author of `changes`,
 * by the authors' sorted IDs, so up to eight authors in one file never
 * share a colour.
 */
// ponytail: colours are per file and not from \definechangesauthor, so they
// can differ from the PDF's. Read the declared colours in core if that
// confuses readers.
export function authorColours(
	changes: readonly { author?: string }[],
): (author: string) => string {
	const ids = [...new Set(changes.map((c) => c.author ?? ""))].sort();
	return (author) => `author-${Math.max(0, ids.indexOf(author)) % 8}`;
}

class PreambleWidget extends WidgetType {
	override eq() {
		return true;
	}
	toDOM(view: EditorView) {
		const row = document.createElement("div");
		row.className = "rich-preamble";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "quiet";
		button.setAttribute(
			"aria-label",
			"Document setup: show the LaTeX before the text",
		);
		const title = document.createElement("span");
		title.textContent = "Document setup";
		const hint = document.createElement("span");
		hint.className = "muted";
		hint.textContent = "Packages, title, and definitions";
		button.append(title, hint);
		button.addEventListener("click", () => {
			view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
			view.focus();
		});
		row.append(button);
		return row;
	}
}

class PlanWidget extends WidgetType {
	private readonly key: string;
	constructor(readonly data: Widget) {
		super();
		this.key = JSON.stringify(data);
	}
	override eq(other: PlanWidget) {
		return other.key === this.key;
	}
	toDOM() {
		return widgetDOM(this.data);
	}
	// Rough heights for block widgets off screen, so the scrollbar and
	// scroll position do not jump when they are first drawn.
	override get estimatedHeight() {
		const w = this.data;
		if (w.kind === "math" && w.display) return 56;
		if (w.kind === "table") return 28 * w.rows.length + 24;
		return -1;
	}
	// Let CodeMirror place the cursor on a click, which reveals the source.
	override ignoreEvent() {
		return false;
	}
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	e.className = className;
	if (text !== undefined) e.textContent = text;
	return e;
}

function widgetDOM(w: Widget): HTMLElement {
	switch (w.kind) {
		case "math":
			return mathDOM(w.tex, w.display, w.macros);
		case "cite":
			return citeDOM(w);
		case "value":
			return valueDOM(w);
		case "ref":
			return refDOM(w);
		case "label": {
			const e = el("span", "rich-chip rich-label", w.key);
			e.setAttribute("role", "note");
			e.setAttribute("aria-label", `Label: ${w.key}`);
			e.title = `Label ${w.key}`;
			return e;
		}
		case "item": {
			const marker =
				w.list === "enumerate"
					? `${w.number}.`
					: (["•", "◦", "▪"][(w.depth - 1) % 3] ?? "•");
			const e = el("span", "rich-item", marker);
			e.setAttribute("aria-hidden", "true");
			return e;
		}
		case "symbol":
			return el("span", "rich-symbol", w.text);
		case "table":
			return tableDOM(w);
		case "image":
			return el("span", "rich-figure-missing", w.path);
		case "softbreak": {
			const e = el("span", "rich-softbreak", "↳");
			e.setAttribute("aria-label", "line break");
			e.title =
				"A line break in the source, read as a space. Delete it to join the lines.";
			return e;
		}
	}
}

// ponytail: rendered formulas are kept for the page's lifetime, keyed by
// their LaTeX and the macro definitions they use; a manuscript has hundreds,
// not millions. Add an LRU bound if memory ever shows it.
const formulas = new Map<string, HTMLElement>();

/** A rendered formula. KaTeX runs once per distinct formula and definitions;
 * scrolling a formula back into view clones the cached DOM. */
function mathDOM(
	tex: string,
	display: boolean,
	macros?: Record<string, string>,
): HTMLElement {
	const key = `${display ? "D" : "I"}${tex}${macros ? `\0${JSON.stringify(macros)}` : ""}`;
	let e = formulas.get(key);
	if (!e) {
		e = el(
			display ? "div" : "span",
			`rich-math ${display ? "display" : "inline"}`,
		);
		try {
			katex.render(tex, e, {
				displayMode: display,
				throwOnError: false,
				trust: false,
				output: "html",
				// A copy: KaTeX writes a \gdef in the formula into it.
				macros: { ...macros },
			});
			e.setAttribute("role", "img");
			e.setAttribute("aria-label", tex);
		} catch {
			e.textContent = tex;
			e.classList.add("rich-error");
			e.title = "This formula cannot be shown; its LaTeX is shown instead.";
		}
		formulas.set(key, e);
	}
	return e.cloneNode(true) as HTMLElement;
}

function valueDOM(w: ValueWidget): HTMLElement {
	const e = el("span", "rich-value", w.text);
	e.title = `\\${w.name}`;
	return e;
}

function keyDOM(
	kind: "citation" | "reference",
	key: string,
	resolved: boolean,
) {
	const e = el("span", resolved ? "key" : "key unresolved", key);
	e.setAttribute("role", "note");
	const name = kind === "citation" ? "Citation" : "Reference";
	e.setAttribute(
		"aria-label",
		resolved ? `${name}: ${key}` : `Unresolved ${kind}: ${key}`,
	);
	e.title = resolved
		? `${name} ${key}`
		: kind === "citation"
			? `No bibliography entry has the key ${key}`
			: `No \\label is named ${key}`;
	return e;
}

function citeDOM(w: CiteWidget): HTMLElement {
	const e = el("span", "rich-chip rich-cite");
	if (!w.keys.every((k) => k.resolved)) e.classList.add("has-unresolved");
	const parts: (string | HTMLElement)[] = [];
	parts.push("(");
	if (w.pre) parts.push(`${w.pre} `);
	w.keys.forEach((k, i) => {
		if (i > 0) parts.push("; ");
		parts.push(keyDOM("citation", k.key, k.resolved));
	});
	if (w.post) parts.push(`, ${w.post}`);
	parts.push(")");
	e.append(...parts);
	return e;
}

function refDOM(w: RefWidget): HTMLElement {
	const e = el("span", "rich-chip rich-ref");
	if (!w.keys.every((k) => k.resolved)) e.classList.add("has-unresolved");
	w.keys.forEach((k, i) => {
		if (i > 0) e.append(", ");
		e.append(keyDOM("reference", k.key, k.resolved));
	});
	return e;
}

function fragmentDOM(f: Fragment): Node {
	switch (f.kind) {
		case "text": {
			let node: Node = document.createTextNode(f.text);
			for (const style of [...f.styles].reverse()) {
				const wrap = el("span", `rich-${style}`);
				wrap.append(node);
				node = wrap;
			}
			return node;
		}
		case "math":
			return mathDOM(f.tex, false, f.macros);
		case "cite":
			return citeDOM(f);
		case "value":
			return valueDOM(f);
		case "ref":
			return refDOM(f);
		case "raw":
			return el("code", "rich-raw", f.text);
	}
}

function tableDOM(w: Extract<Widget, { kind: "table" }>): HTMLElement {
	const wrap = el("div", "rich-table");
	const table = document.createElement("table");
	for (const row of w.rows) {
		const tr = document.createElement("tr");
		if (row.ruleAbove) tr.classList.add("rule-above");
		if (row.ruleBelow) tr.classList.add("rule-below");
		let column = 0;
		for (const cell of row.cells) {
			const td = document.createElement("td");
			if (cell.span) td.colSpan = cell.span;
			const align = w.align[column];
			if (align)
				td.style.textAlign = { l: "left", c: "center", r: "right" }[align];
			column += cell.span ?? 1;
			td.append(...cell.content.map(fragmentDOM));
			tr.append(td);
		}
		table.append(tr);
	}
	wrap.append(table);
	return wrap;
}

// Figures load one at a time in idle moments after a file opens, so that
// drawing a PDF figure (pdf.js paints on the main thread) does not stall
// scrolling when the figure first comes into view.
let queue: Promise<unknown> = Promise.resolve();
function prefetch(path: string, load: (path: string) => Promise<string>) {
	if (figures.has(path)) return;
	queue = queue
		.then(() => new Promise((r) => requestIdleCallback(r, { timeout: 2000 })))
		.then(() => load(path))
		.then(async (url) => {
			// Decoded once here, the image is ready the moment a widget shows it.
			const img = new Image();
			img.src = url;
			await img.decode();
			if (!figures.has(path)) figures.set(path, { url, height: 0 });
		})
		.catch(() => {});
}

// Figure URLs that have loaded, so a figure scrolled back into view is
// drawn at once, and the height it had, for the estimate off screen.
const figures = new Map<string, { url: string; height: number }>();

class FigureWidget extends WidgetType {
	constructor(
		readonly written: string,
		readonly resolved: string | undefined,
		readonly load: (path: string) => Promise<string>,
	) {
		super();
	}
	override eq(other: FigureWidget) {
		return other.written === this.written && other.resolved === this.resolved;
	}
	toDOM(view: EditorView) {
		const box = el("div", "rich-figure");
		const placeholder = (why: string) => {
			const p = el("div", "rich-figure-missing");
			p.append(el("span", "", why), el("code", "", this.written));
			box.replaceChildren(p);
		};
		const resolved = this.resolved;
		if (!resolved) {
			placeholder("Figure file not found:");
			return box;
		}
		const show = (url: string) => {
			const img = document.createElement("img");
			img.alt = this.written;
			img.src = url;
			img.addEventListener("load", () => {
				figures.set(resolved, { url, height: box.offsetHeight });
				view.requestMeasure();
			});
			box.classList.remove("loading");
			box.replaceChildren(img);
		};
		const ready = figures.get(resolved);
		if (ready) {
			show(ready.url);
			return box;
		}
		box.classList.add("loading");
		this.load(resolved).then(show, () => {
			box.classList.remove("loading");
			placeholder("This figure cannot be shown here:");
		});
		return box;
	}
	override get estimatedHeight() {
		return (this.resolved && figures.get(this.resolved)?.height) || 200;
	}
	override ignoreEvent() {
		return false;
	}
}
