// The render plan for the inline view: from source text and the project
// index, plain data saying what to hide, style, or replace with a widget.
// The UI maps it one-to-one onto CodeMirror decorations.
import { type Change, changeOf } from "./changes";
import type { ProjectIndex } from "./project";
import {
	type Command,
	type Env,
	type Group,
	type MathNode,
	type Node,
	type Range,
	scan,
} from "./scan";

/**
 * A rendered construct. When the editor selection touches `[from, to]`
 * (either edge counts), the UI drops the group's `hide` and `widget`
 * primitives so its source shows; see {@link revealSelection}. Groups nest
 * the way the constructs do. `id` is the group's index in `Plan.groups`.
 */
export interface PlanGroup extends Range {
	id: number;
}

/** Inline style classes. Several can apply to one range by nesting. */
export type MarkClass =
	| "heading"
	| "emph"
	| "bold"
	| "italic"
	| "mono"
	| "underline"
	| "smallcaps"
	| "superscript"
	| "subscript"
	| "item-label"
	| "caption"
	| "added"
	| "deleted"
	| "highlight"
	| "comment";

/**
 * One decoration. Primitives are sorted by `from`; `hide` and `widget`
 * ranges never overlap each other (they may touch). A `hide` or block
 * `widget` may span line breaks, so the UI must provide them from a state
 * field, not a view plugin. Ties at one offset are unordered: build the set
 * with `Decoration.set(ranges, true)`.
 *
 * - `hide`: replace the range with nothing.
 * - `mark`: style the range. `attrs`, when present:
 *   `heading` has `level` ("0" for `\part` … "6" for `\subparagraph`);
 *   `caption` has `float` ("figure" or "table") inside a float;
 *   change marks have `change` (the {@link Change} kind) and, when given,
 *   `author` and `comment`.
 * - `widget`: replace the range with a rendered {@link Widget}. A `block`
 *   widget covers whole lines.
 * - `line`: attributes for the line starting at `from` (`from === to`).
 *   Lines belong to no group and are never revealed.
 *
 * `group` is -1 for a primitive that belongs to no construct and never
 * reveals: a soft line break.
 */
export type Primitive =
	| { type: "hide"; from: number; to: number; group: number }
	| {
			type: "mark";
			from: number;
			to: number;
			group: number;
			class: MarkClass;
			attrs?: Record<string, string>;
	  }
	| {
			type: "widget";
			from: number;
			to: number;
			group: number;
			block: boolean;
			widget: Widget;
	  }
	| {
			type: "line";
			from: number;
			to: number;
			/** `list`: a line inside a list; `attrs.depth` is "1" for the outermost. */
			class: "list";
			attrs: Record<string, string>;
	  };

/** A citation key or label key and whether the repository defines it. */
export interface KeyStatus {
	key: string;
	resolved: boolean;
}

/**
 * Math for KaTeX. `tex` is ready for `katex.render(tex, el, { displayMode:
 * display })`: environments KaTeX lacks are mapped (`multline` to
 * `gathered`, `flalign` to `align`) and `\label`s are removed.
 */
export interface MathWidget {
	kind: "math";
	tex: string;
	display: boolean;
}

/** `\cite` and friends. `pre`/`post` are the optional notes as written. */
export interface CiteWidget {
	kind: "cite";
	/** Command name without backslash or star, such as `citep`. */
	command: string;
	star: boolean;
	pre?: string;
	post?: string;
	keys: KeyStatus[];
}

/** `\ref`, `\eqref`, `\cref` and friends. */
export interface RefWidget {
	kind: "ref";
	command: string;
	keys: KeyStatus[];
}

/** A run of inside-a-table content the UI can render without LaTeX. */
export type Fragment =
	| {
			kind: "text";
			/** Plain text: escapes decoded, `~` as U+00A0, whitespace collapsed. */
			text: string;
			/** Outermost first. */
			styles: MarkClass[];
	  }
	| MathWidget
	| CiteWidget
	| RefWidget
	/** Unrecognised source, shown as written. */
	| { kind: "raw"; text: string };

export interface TableCell {
	/** Columns spanned by a `\multicolumn`; absent means 1. */
	span?: number;
	content: Fragment[];
}

export interface TableRow {
	/** A horizontal rule (`\hline`, `\toprule`, …) above this row. */
	ruleAbove?: true;
	/** A rule below this row; only set on the last row. */
	ruleBelow?: true;
	cells: TableCell[];
}

/** What a `widget` primitive shows. */
export type Widget =
	| MathWidget
	| CiteWidget
	| RefWidget
	/**
	 * A control symbol such as `\%` or a tie `~`, shown as the character it
	 * prints (`~` as U+00A0).
	 */
	| { kind: "symbol"; text: string }
	/** `\label` or `\linelabel`, shown as a small chip. */
	| { kind: "label"; command: string; key: string }
	/**
	 * `\includegraphics`. `path` is as written; resolve it with
	 * `resolveGraphicsPath` from `./project`.
	 */
	| { kind: "image"; path: string; options?: string }
	/**
	 * The marker of a bare `\item`. `number` counts the list's bare items
	 * from 1; `depth` is 1 for the outermost list.
	 */
	| {
			kind: "item";
			list: "itemize" | "enumerate" | "description";
			depth: number;
			number: number;
	  }
	/** A whole `tabular`. `align` has one entry per column. */
	| { kind: "table"; align: ("l" | "c" | "r")[]; rows: TableRow[] }
	/**
	 * A single line break inside a paragraph, which TeX reads as a space:
	 * the lines flow as one and a faint mark stands at the join. It never
	 * reveals (its `group` is -1); see {@link joinSoftBreak} for deleting it.
	 */
	| { kind: "softbreak" };

/** A `changes` macro and the group whose range is the whole macro. */
export interface PlanChange extends Change {
	group: number;
}

/** The render plan of one file. */
export interface Plan {
	/**
	 * Where decorations may start: just after `\begin{document}`, 0 for a
	 * file without `\documentclass`, or the text length for a preamble with
	 * no document body.
	 */
	bodyStart: number;
	primitives: Primitive[];
	groups: PlanGroup[];
	/** Every `changes` macro in the body, in source order, outer before inner. */
	changes: PlanChange[];
}

const headingLevels = new Map(
	[
		"part",
		"chapter",
		"section",
		"subsection",
		"subsubsection",
		"paragraph",
		"subparagraph",
	].map((name, level) => [name, String(level)]),
);
const emphasis = new Map<string, MarkClass>([
	["emph", "emph"],
	["textbf", "bold"],
	["textit", "italic"],
	["texttt", "mono"],
	["underline", "underline"],
	["textsc", "smallcaps"],
	["textsuperscript", "superscript"],
	["textsubscript", "subscript"],
]);
const cites = new Set(
	"cite citep citet citealp citealt parencite textcite autocite footcite citeauthor citeyear Citep Citet Parencite Textcite Autocite".split(
		" ",
	),
);
const refs = new Set(
	"ref eqref pageref autoref cref Cref nameref lineref".split(" "),
);
const lists = new Set(["itemize", "enumerate", "description"]);
const floats = new Map([
	["figure", "figure"],
	["figure*", "figure"],
	["table", "table"],
	["table*", "table"],
]);
const tabulars = new Set(["tabular", "tabular*", "tabularx"]);
// ponytail: `\cline` and `\cmidrule` draw as full-width rules. Add a column
// range to `TableRow` if partial rules matter to readers.
const rules = new Set(
	"hline toprule midrule bottomrule cline cmidrule".split(" "),
);
const escapes = new Map([
	["\\%", "%"],
	["\\&", "&"],
	["\\$", "$"],
	["\\#", "#"],
	["\\_", "_"],
	["\\{", "{"],
	["\\}", "}"],
	["\\ ", " "],
	["\\,", " "],
]);
const katexEnvs = new Map([
	["multline", "gathered"],
	["multline*", "gathered"],
	["flalign", "align"],
	["flalign*", "align*"],
]);
const labelPattern = /\\label\s*\{[^{}]*\}/g;

/** How to render. */
export interface PlanOptions {
	/**
	 * Show `changes` markup (default true). False is a clean reading view,
	 * like a word processor's "No markup": comments and inserted text read
	 * as plain text, and deleted text, the old text of replacements, and
	 * `\comment` notes are hidden. Hidden text, like hidden markup, belongs
	 * to the change's group and never reveals; guard edits around it with
	 * `guardEdit(…, markup = false)`.
	 */
	markup?: boolean;
}

/**
 * The render plan for `text`, resolving keys against `index`. Never
 * throws. Anything it does not recognise gets no primitives, so it shows
 * as editable source.
 */
export function buildPlan(
	text: string,
	index: ProjectIndex,
	options: PlanOptions = {},
): Plan {
	const markup = options.markup ?? true;
	const root = scan(text);
	const primitives: Primitive[] = [];
	const groups: PlanGroup[] = [];
	const changes: PlanChange[] = [];
	const lineDepth = new Map<number, number>();
	const hiddenLines = new Set<number>();

	let body: Node[] = root.children;
	let bodyStart = 0;
	const top = root.children;
	if (top.some((n) => n.kind === "command" && n.name === "documentclass")) {
		const doc = top.find((n) => n.kind === "env" && n.name === "document");
		body = doc?.kind === "env" ? doc.children.slice(1) : [];
		if (doc?.kind === "env" && doc.end) body.pop();
		bodyStart = doc?.kind === "env" ? doc.begin.to : text.length;
	}

	const group = (from: number, to: number): number => {
		groups.push({ id: groups.length, from, to });
		return groups.length - 1;
	};
	const hide = (from: number, to: number, g: number) => {
		if (to > from) primitives.push({ type: "hide", from, to, group: g });
	};
	const mark = (
		r: Range,
		g: number,
		cls: MarkClass,
		attrs?: Record<string, string>,
	) => {
		if (r.to <= r.from) return;
		primitives.push({
			type: "mark",
			from: r.from,
			to: r.to,
			group: g,
			class: cls,
			...(attrs && { attrs }),
		});
	};
	const widget = (r: Range, w: Widget, block = false) => {
		const g = group(r.from, r.to);
		primitives.push({
			type: "widget",
			from: r.from,
			to: r.to,
			group: g,
			block,
			widget: w,
		});
	};
	const inner = (g: Group) => text.slice(g.from + 1, g.to - 1);

	// The line holding `r` when nothing but blanks shares it.
	const ownLine = (r: Range): Range | undefined => {
		let from = r.from;
		while (from > 0 && isBlank(text.charCodeAt(from - 1))) from--;
		if (from > 0 && text.charCodeAt(from - 1) !== 10) return undefined;
		let to = r.to;
		while (to < text.length && isBlank(text.charCodeAt(to))) to++;
		if (to < text.length && text.charCodeAt(to) !== 10) return undefined;
		return { from, to };
	};

	// Hides scaffolding such as `\begin{itemize}`. When it has a line of its
	// own the line goes too, with the line break before it: CodeMirror styles
	// a joined line by its first line, so the next visible line keeps its own.
	const scaffold = (r: Range) => {
		const g = group(r.from, r.to);
		const line = ownLine(r);
		if (!line) return hide(r.from, r.to, g);
		hiddenLines.add(line.from);
		hide(line.from > bodyStart ? line.from - 1 : line.from, line.to, g);
	};

	// `\cmd[opt]{arg}` shown as the styled content of `arg`.
	const styled = (
		cmd: Command,
		arg: Group | undefined,
		cls: MarkClass,
		attrs?: Record<string, string>,
	): boolean => {
		if (!arg?.closed || cmd.args.some((a) => a && !a.closed)) return false;
		const g = group(cmd.from, cmd.to);
		hide(cmd.from, arg.from + 1, g);
		mark({ from: arg.from + 1, to: arg.to - 1 }, g, cls, attrs);
		walk(arg.children, undefined);
		hide(arg.to - 1, cmd.to, g);
		return true;
	};

	const change = (cmd: Command): boolean => {
		const c = changeOf(text, cmd);
		if (!c) return false;
		const g = group(c.from, c.to);
		changes.push({ ...c, group: g });
		const attrs: Record<string, string> = { change: c.kind };
		if (c.author !== undefined) attrs.author = c.author;
		if (c.comment !== undefined) attrs.comment = c.comment;
		const [, first, second] = cmd.args;
		if (!markup && (c.kind === "deleted" || c.kind === "comment")) {
			hide(c.from, c.to, g);
			return true;
		}
		hide(c.from, c.text.from, g);
		const cls = c.kind === "replaced" ? "added" : c.kind;
		if (markup) mark(c.text, g, cls, attrs);
		walk(first?.children ?? [], undefined);
		if (c.old && !markup) {
			hide(c.text.to, c.to, g);
		} else if (c.old) {
			hide(c.text.to, c.old.from, g);
			mark(c.old, g, "deleted", attrs);
			walk(second?.children ?? [], undefined);
			hide(c.old.to, c.to, g);
		} else {
			hide(c.text.to, c.to, g);
		}
		return true;
	};

	const command = (cmd: Command, float: string | undefined): boolean => {
		const { name, args } = cmd;
		const level = headingLevels.get(name);
		if (level !== undefined) {
			return styled(cmd, args[1], "heading", { level });
		}
		const cls = emphasis.get(name);
		if (cls) return styled(cmd, args[0], cls);
		if (name === "caption") {
			return styled(cmd, args[1], "caption", float ? { float } : undefined);
		}
		if (cites.has(name) || refs.has(name)) {
			const w = keyed(text, cmd, index);
			if (w) widget(cmd, w);
			return !!w;
		}
		if (name === "label" || name === "linelabel") {
			const key = args[0]?.closed ? inner(args[0]).trim() : "";
			if (key) widget(cmd, { kind: "label", command: name, key });
			return !!key;
		}
		if (name === "includegraphics") {
			const [opt, path] = args;
			if (!path?.closed || (opt && !opt.closed)) return false;
			const line = ownLine(cmd);
			const w: Widget = { kind: "image", path: inner(path).trim() };
			if (opt) w.options = inner(opt);
			widget(line ?? cmd, w, !!line);
			return true;
		}
		return change(cmd);
	};

	const list = (env: Env, depth: number) => {
		const end = env.end;
		if (!end) return false;
		const kind = env.name as "itemize" | "enumerate" | "description";
		for (
			let i = text.indexOf("\n", env.begin.to);
			i >= 0 && i < end.from;
			i = text.indexOf("\n", i + 1)
		) {
			lineDepth.set(i + 1, depth);
		}
		scaffold(env.begin);
		let number = 0;
		for (const node of env.children.slice(1, -1)) {
			if (node.kind !== "command" || node.name !== "item") {
				walk([node], undefined, depth);
				continue;
			}
			const label = node.args[0];
			if (!label) {
				widget(node, { kind: "item", list: kind, depth, number: ++number });
			} else if (label.closed) {
				const g = group(node.from, node.to);
				hide(node.from, label.from + 1, g);
				mark({ from: label.from + 1, to: label.to - 1 }, g, "item-label");
				walk(label.children, undefined, depth);
				hide(label.to - 1, label.to, g);
			}
		}
		scaffold(end);
		return true;
	};

	const environment = (
		env: Env,
		float: string | undefined,
		depth: number,
	): void => {
		if (lists.has(env.name) && list(env, depth + 1)) return;
		const kind = floats.get(env.name);
		if (kind && env.end) {
			scaffold(env.begin);
			for (const node of env.children.slice(1, -1)) {
				if (node.kind === "command" && node.name === "centering")
					scaffold(node);
				else walk([node], kind, depth);
			}
			scaffold(env.end);
			return;
		}
		if (tabulars.has(env.name) && env.end) {
			const line = ownLine(env);
			widget(line ?? env, table(text, env, index), !!line);
			return;
		}
		walk(env.children, float, depth);
	};

	function walk(nodes: Node[], float: string | undefined, depth = 0): void {
		for (const node of nodes) {
			if (node.kind === "math") {
				const line = node.display ? ownLine(node) : undefined;
				widget(line ?? node, mathWidget(text, node), !!line);
			} else if (node.kind === "env") {
				environment(node, float, depth);
			} else if (node.kind === "command") {
				if (!command(node, float)) walk(node.children, float, depth);
			} else if (node.kind === "group") {
				walk(node.children, float, depth);
			} else if (node.kind === "escape") {
				const s = escapes.get(text.slice(node.from, node.to));
				if (s !== undefined) widget(node, { kind: "symbol", text: s });
			} else if (node.kind === "text") {
				for (
					let i = text.indexOf("~", node.from);
					i >= 0 && i < node.to;
					i = text.indexOf("~", i + 1)
				) {
					widget({ from: i, to: i + 1 }, { kind: "symbol", text: "\u00a0" });
				}
				for (
					let i = text.indexOf("\n", node.from);
					i >= 0 && i < node.to;
					i = text.indexOf("\n", i + 1)
				) {
					if (!softBreak(text, i)) continue;
					primitives.push({
						type: "widget",
						from: i,
						to: i + 1,
						group: -1,
						block: false,
						widget: { kind: "softbreak" },
					});
				}
			}
		}
	}

	walk(body, undefined);

	for (const [from, depth] of lineDepth) {
		if (hiddenLines.has(from)) continue;
		primitives.push({
			type: "line",
			from,
			to: from,
			class: "list",
			attrs: { depth: String(depth) },
		});
	}
	primitives.sort((a, b) => a.from - b.from);
	// Belt and braces: the editor rejects overlapping replacements outright,
	// so drop any that slip through rather than break the view.
	let end = 0;
	const safe = primitives.filter((p) => {
		if (p.type !== "hide" && p.type !== "widget") return true;
		if (p.from < end) return false;
		end = p.to;
		return true;
	});
	return { bodyStart, primitives: safe, groups, changes };
}

/**
 * `plan` with every group the selection touches revealed: its `hide` and
 * `widget` primitives are dropped, while marks and lines stay. A range
 * touches a group when they overlap or share an edge.
 *
 * The markup of a `changes` macro is never revealed: someone typing with
 * tracking on is always inside one, and would otherwise see raw macros the
 * whole time. Constructs inside its text reveal as usual. The UI shows the
 * markup only in Source mode, and keeps it whole with `guardEdit` from
 * `core/changes`.
 */
export function revealSelection(plan: Plan, selection: readonly Range[]): Plan {
	const sticky = new Set(plan.changes.map((c) => c.group));
	const touched = new Set<number>();
	for (const g of plan.groups) {
		if (sticky.has(g.id)) continue;
		if (selection.some((r) => r.from <= g.to && r.to >= g.from))
			touched.add(g.id);
	}
	if (touched.size === 0) return plan;
	return {
		...plan,
		primitives: plan.primitives.filter(
			(p) => p.type === "mark" || p.type === "line" || !touched.has(p.group),
		),
	};
}

// Lines that start with these stand on their own: a line break next to them
// is not inside running prose.
const blockLine =
	/^\s*(?:\\(?:begin|end|item|part|chapter|section|subsection|subsubsection|paragraph|subparagraph|label|linelabel|caption|centering|maketitle|tableofcontents|bibliography|bibliographystyle|printbibliography|input|include|subfile|includegraphics|newpage|clearpage|par|noindent|vspace|medskip|bigskip|smallskip)(?![A-Za-z])|\\\[|\\\]|\$\$|%)/;
const forcedBreak = /\\\\\*?\s*(?:\[[^\]]*\])?\s*$/;
const comment = /(?:^|[^\\])(?:\\\\)*%/;

// Whether the line break at `i`, in body text, joins two lines of running
// prose. A line that starts with `\item` may continue onto the next.
function softBreak(text: string, i: number): boolean {
	const prev = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	const end = text.indexOf("\n", i + 1);
	const next = text.slice(i + 1, end < 0 ? text.length : end);
	if (!prev.trim() || !next.trim()) return false;
	if (forcedBreak.test(prev) || comment.test(prev)) return false;
	if (blockLine.test(next)) return false;
	return !blockLine.test(prev) || /^\s*\\item(?![A-Za-z])/.test(prev);
}

const noIndex: ProjectIndex = {
	labels: new Map(),
	citations: new Map(),
	includes: new Map(),
	graphicsPaths: [],
};

/**
 * What deleting a soft line break's mark does: Backspace after it (or
 * Delete before it, `forward`) arrives as the deletion of exactly its `\n`.
 * The break and the blanks around it become one space, so the words stay
 * apart by exactly one space, and the cursor stays on its side of the join.
 * `undefined` for any other edit, which goes in as it is.
 */
export function joinSoftBreak(
	text: string,
	edit: Range & { insert: string },
	forward = false,
): { edits: (Range & { insert: string })[]; cursor: number } | undefined {
	const { from, to, insert } = edit;
	if (insert || to !== from + 1 || text[from] !== "\n") return undefined;
	const soft = buildPlan(text, noIndex).primitives.some(
		(p) =>
			p.type === "widget" && p.widget.kind === "softbreak" && p.from === from,
	);
	if (!soft) return undefined;
	let a = from;
	while (a > 0 && isBlank(text.charCodeAt(a - 1))) a--;
	let b = to;
	while (b < text.length && isBlank(text.charCodeAt(b))) b++;
	return {
		edits: [{ from: a, to: b, insert: " " }],
		cursor: forward ? a : a + 1,
	};
}

function isBlank(c: number): boolean {
	return c === 32 || c === 9 || c === 13;
}

function mathWidget(text: string, node: MathNode): MathWidget {
	let tex = text.slice(node.bodyFrom, node.bodyTo).replace(labelPattern, "");
	const env = node.env;
	if (env && env !== "math" && env !== "displaymath") {
		const name = katexEnvs.get(env) ?? env;
		tex = `\\begin{${name}}${tex}\\end{${name}}`;
	} else {
		tex = tex.trim();
	}
	return { kind: "math", tex, display: node.display };
}

// A citation or reference widget, when the command is complete.
function keyed(
	text: string,
	cmd: Command,
	index: ProjectIndex,
): CiteWidget | RefWidget | undefined {
	if (cmd.args.some((a) => a && !a.closed)) return undefined;
	const arg = cmd.args.at(-1);
	if (!arg || arg.bracket) return undefined;
	const keys = text
		.slice(arg.from + 1, arg.to - 1)
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);
	if (keys.length === 0) return undefined;
	if (refs.has(cmd.name)) {
		return {
			kind: "ref",
			command: cmd.name,
			keys: keys.map((key) => ({ key, resolved: index.labels.has(key) })),
		};
	}
	const w: CiteWidget = {
		kind: "cite",
		command: cmd.name,
		star: cmd.star,
		keys: [],
	};
	const [a, b] = cmd.args.map(
		(g) => g && text.slice(g.from + 1, g.to - 1).trim(),
	);
	const pre = b === undefined ? undefined : a;
	const post = b === undefined ? a : b;
	if (pre) w.pre = pre;
	if (post) w.post = post;
	w.keys = keys.map((key) => ({ key, resolved: index.citations.has(key) }));
	return w;
}

// Column alignments from a column spec such as `l|c r` or `@{}p{3cm}*{2}{c}`.
function columns(spec: string): ("l" | "c" | "r")[] {
	const out: ("l" | "c" | "r")[] = [];
	for (let i = 0; i < spec.length && out.length < 100; i++) {
		const c = spec[i];
		if (c === "l" || c === "c" || c === "r") out.push(c);
		else if (c === "p" || c === "m" || c === "b" || c === "X") out.push("l");
		else if (c === "S") out.push("c");
		else if (c === "*") {
			const m = /^\*\{(\d+)\}\{([^{}]*)\}/.exec(spec.slice(i));
			if (!m) continue;
			const inner = columns(m[2] ?? "");
			for (let k = 0; k < Number(m[1]) && out.length < 100; k++)
				out.push(...inner);
			i += m[0].length - 1;
		}
		if (spec[i + 1] === "{") {
			// Skip the argument of p{…}, @{…}, >{…} and the like.
			let level = 0;
			for (i++; i < spec.length; i++) {
				if (spec[i] === "{") level++;
				else if (spec[i] === "}" && --level === 0) break;
			}
		}
	}
	return out;
}

// The table widget for a closed tabular environment.
// ponytail: cells know styles, math, citations and references; anything
// else, `changes` markup and `\label` included, is a raw fragment. Teach
// `fragments` more kinds when tables with tracked changes show up.
function table(text: string, env: Env, index: ProjectIndex): Widget {
	const spec = env.begin.args.at(-1);
	const align =
		spec && !spec.bracket
			? columns(text.slice(spec.from + 1, spec.to - 1))
			: [];
	const rows: TableRow[] = [];
	let row: TableRow = { cells: [] };
	let cell: TableCell = { content: [] };
	let skipRuleArg = false;

	const push = (f: Fragment) => cell.content.push(f);
	const addText = (s: string, styles: MarkClass[]) => {
		const last = cell.content.at(-1);
		if (last?.kind === "text" && last.styles.join() === styles.join())
			last.text += s;
		else push({ kind: "text", text: s, styles });
	};
	const endCell = () => {
		const c = cell.content;
		const first = c[0];
		if (first?.kind === "text") first.text = first.text.trimStart();
		const last = c.at(-1);
		if (last?.kind === "text") last.text = last.text.trimEnd();
		cell.content = c.filter((f) => f.kind !== "text" || f.text);
		row.cells.push(cell);
		cell = { content: [] };
	};
	const endRow = () => {
		endCell();
		rows.push(row);
		row = { cells: [] };
	};
	const empty = (r: TableRow) =>
		r.cells.every((c) => c.content.length === 0 && !c.span);

	const fragments = (nodes: Node[], styles: MarkClass[], top: boolean) => {
		for (const node of nodes) {
			if (node.kind === "text") {
				const parts = top
					? text.slice(node.from, node.to).split("&")
					: [text.slice(node.from, node.to)];
				parts.forEach((part, i) => {
					if (i > 0) endCell();
					const s = part.replace(/\s+/g, " ").replaceAll("~", " ");
					if (!s) return;
					if (skipRuleArg && s.trim()) skipRuleArg = s.trim().startsWith("(");
					if (!skipRuleArg) addText(s, styles);
				});
			} else if (node.kind === "escape") {
				const s = escapes.get(text.slice(node.from, node.to));
				if (s !== undefined) addText(s, styles);
				else push({ kind: "raw", text: text.slice(node.from, node.to) });
			} else if (node.kind === "math") {
				push(mathWidget(text, node));
			} else if (node.kind === "group") {
				if (skipRuleArg) skipRuleArg = false;
				else fragments(node.children, styles, false);
			} else if (node.kind === "command") {
				const { name, args } = node;
				const raw = () =>
					push({ kind: "raw", text: text.slice(node.from, node.to) });
				if (top && name === "\\") {
					endRow();
				} else if (top && rules.has(name)) {
					if (
						empty(row) &&
						cell.content.every((f) => f.kind === "text" && !f.text.trim())
					) {
						row.ruleAbove = true;
						cell.content = [];
					}
					skipRuleArg = name === "cmidrule";
				} else if (emphasis.has(name) && args[0]?.closed) {
					fragments(
						args[0].children,
						[...styles, emphasis.get(name) as MarkClass],
						false,
					);
				} else if (cites.has(name) || refs.has(name)) {
					const w = keyed(text, node, index);
					if (w) push(w);
					else raw();
				} else if (
					top &&
					name === "multicolumn" &&
					args[2]?.closed &&
					args[0]?.closed
				) {
					const span = Number.parseInt(
						text.slice(args[0].from + 1, args[0].to - 1),
						10,
					);
					if (span > 1) cell.span = span;
					fragments(args[2].children, styles, false);
				} else {
					raw();
				}
			}
			// Comments, open/close delimiters and the like contribute nothing.
		}
	};

	fragments(env.children.slice(1, -1), [], true);
	endRow();
	const last = rows.at(-1);
	if (last && empty(last)) {
		rows.pop();
		const prev = rows.at(-1);
		if (last.ruleAbove && prev) prev.ruleBelow = true;
	}
	return { kind: "table", align, rows };
}
