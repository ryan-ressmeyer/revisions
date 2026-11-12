// Editing operations on `changes` package markup: comments, tracked changes,
// the author declarations they need, and accepting or rejecting them. Every
// function is pure: it takes source text and returns minimal edits to it.
import { type Change, changeOf, findChanges } from "../latex/changes";
import {
	type Command,
	type Env,
	type Node,
	type Range,
	scan,
} from "../latex/scan";

/**
 * Replace `from`–`to` of the original text with `insert`. Offsets always
 * refer to the text the edit list was computed from, not to the text after
 * earlier edits in the same list. Edit lists are sorted and do not overlap.
 */
export interface Edit extends Range {
	insert: string;
}

/** Edits to apply, or a plain-language reason the operation was refused. */
export type Outcome =
	| { ok: true; edits: Edit[] }
	| { ok: false; reason: string };

/** `text` with a sorted, non-overlapping edit list applied. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
	let out = "";
	let at = 0;
	for (const edit of edits) {
		out += text.slice(at, edit.from) + edit.insert;
		at = edit.to;
	}
	return out + text.slice(at);
}

const escapes: Record<string, string> = {
	"\\": "\\textbackslash{}",
	"^": "\\textasciicircum{}",
	"~": "\\textasciitilde{}",
	"\n": "\\newline{}",
};

/**
 * Comment text as typed by a user, made safe to place inside
 * `comment={…}`: LaTeX specials print as themselves and line breaks
 * (`\n`, `\r\n`, `\r`) become `\newline{}`. {@link unescapeComment}
 * reverses it, except that every line break comes back as `\n`.
 */
export function escapeComment(comment: string): string {
	return comment
		.replace(/\r\n?/g, "\n")
		.replace(/[\\{}%#&_$^~\n]/g, (c) => escapes[c] ?? `\\${c}`);
}

/**
 * The text to show for a {@link Change}'s `comment`. Undoes
 * {@link escapeComment}; any other LaTeX in a hand-written comment is shown
 * as it is.
 */
export function unescapeComment(source: string): string {
	return source.replace(
		/\\(textbackslash|textasciicircum|textasciitilde|newline)\{\}|\\([{}%#&_$])/g,
		(_, word: string | undefined, symbol: string | undefined) =>
			symbol ?? unescapes[word ?? ""] ?? "",
	);
}

const unescapes: Record<string, string> = {
	textbackslash: "\\",
	textasciicircum: "^",
	textasciitilde: "~",
	newline: "\n",
};

/**
 * Wraps the selected text as `\highlight[id=<authorId>, comment={…}]{text}`.
 * Refused, with a reason to show the user, when the selection is empty, the
 * comment is blank, or the selection cannot be wrapped so that the file still
 * compiles: see {@link whyNotWrap}. The author must also be declared in the
 * entry file's preamble: see {@link ensurePreamble}.
 */
export function addComment(
	text: string,
	selection: Range,
	authorId: string,
	comment: string,
): Outcome {
	if (selection.from >= selection.to) {
		return refuse("Select the text you want to comment on first.");
	}
	if (!comment.trim()) return refuse("Write a comment first.");
	return wrapHighlight(
		text,
		selection,
		`\\highlight[id=${authorId}, comment={${escapeComment(comment)}}]{`,
	);
}

/**
 * Wraps the selected text as `\highlight[id=<authorId>]{text}`, a highlight
 * with no comment. Refused for the same selections as {@link addComment};
 * {@link resolveComment} removes it.
 */
export function addHighlight(
	text: string,
	selection: Range,
	authorId: string,
): Outcome {
	if (selection.from >= selection.to) {
		return refuse("Select the text you want to highlight first.");
	}
	return wrapHighlight(text, selection, `\\highlight[id=${authorId}]{`);
}

function wrapHighlight(text: string, selection: Range, open: string): Outcome {
	const why = whyNotWrap(text, selection, "comment");
	if (why) return refuse(why);
	return {
		ok: true,
		edits: [
			{ from: selection.from, to: selection.from, insert: open },
			{ from: selection.to, to: selection.to, insert: "}" },
		],
	};
}

/**
 * Edits that resolve a comment: a `\highlight` loses its markup and keeps
 * its text byte for byte; a standalone `\comment` is removed entirely. Any
 * other kind of change gives no edits.
 */
export function resolveComment(change: Change): Edit[] {
	if (change.kind === "highlight") return unwrap(change, change.text);
	if (change.kind === "comment") return [remove(change)];
	return [];
}

/**
 * Edits that accept one tracked change: `\added` keeps its text, `\deleted`
 * is removed with its text, `\replaced` keeps its new text. Kept text is
 * untouched, nested markup included. No edits for comments.
 */
export function acceptChange(change: Change): Edit[] {
	return settle(change, true);
}

/**
 * Edits that reject one tracked change: `\added` is removed with its text,
 * `\deleted` keeps its text, `\replaced` keeps its old text. Kept text is
 * untouched, nested markup included. No edits for comments.
 */
export function rejectChange(change: Change): Edit[] {
	return settle(change, false);
}

/**
 * Edits that accept every tracked change in `text`, nested ones included,
 * as one sorted list. Comments (`\highlight`, `\comment`) stay, though
 * tracked changes inside them are accepted.
 */
export function acceptAll(text: string): Edit[] {
	return settleAll(text, true);
}

/** Like {@link acceptAll}, but rejects every tracked change. */
export function rejectAll(text: string): Edit[] {
	return settleAll(text, false);
}

function settle(change: Change, accept: boolean): Edit[] {
	switch (change.kind) {
		case "added":
			return accept ? unwrap(change, change.text) : [remove(change)];
		case "deleted":
			return accept ? [remove(change)] : unwrap(change, change.text);
		case "replaced":
			return unwrap(change, accept ? change.text : (change.old ?? change.text));
		default:
			return [];
	}
}

// Outer changes come first, so a change inside text that an outer one
// removes is skipped; one inside kept text gets its own edits.
function settleAll(text: string, accept: boolean): Edit[] {
	const edits: Edit[] = [];
	for (const change of findChanges(text)) {
		if (edits.some((e) => e.from <= change.from && change.to <= e.to)) continue;
		edits.push(...settle(change, accept));
	}
	return edits.sort((a, b) => a.from - b.from);
}

const palette = [
	"blue",
	"red",
	"teal",
	"orange",
	"violet",
	"olive",
	"magenta",
	"brown",
];

/**
 * The preamble block that keeps comments compiling where LaTeX cannot place
 * a margin note. `changes` draws a comment as a todonotes margin note, a
 * float, which fails inside a float, a box, a table cell, a footnote or a
 * boxed abstract. The block switches todonotes to inline notes there and
 * only there: in inner (box) mode, such as `\fbox` or an `l` table cell,
 * where a 10em note keeps the box from running off the page; after
 * `\@arrayparboxrestore`, which floats, minipages, `\parbox`, p columns and
 * footnotes run inside their own group; in `abstract`; and in elsarticle's
 * `frontmatter`. Each setting is local to that place, so body text after it
 * keeps margin notes. It does nothing when todonotes is not loaded (another
 * `commentmarkup`) or LaTeX predates hooks (2020-10). The first line marks
 * it, so it is written once.
 */
const inlineNotes = [
	"% Added by Revisions: draw comments inline where LaTeX cannot place a margin note.",
	"\\ifdefined\\setuptodonotes\\ifdefined\\AddToHook",
	"\\AddToHook{cmd/todo/before}{\\ifinner\\setuptodonotes{inline, inlinewidth=10em}\\fi}% boxes, table cells",
	"\\AddToHook{cmd/@arrayparboxrestore/after}{\\setuptodonotes{inline}}% floats, footnotes",
	"\\AddToHook{env/abstract/begin}{\\setuptodonotes{inline}}% abstracts",
	"\\AddToHook{env/frontmatter/begin}{\\setuptodonotes{inline}}% elsarticle title block",
	"\\fi\\fi",
];

interface Preamble {
	/** Where `\begin{document}` starts. */
	body: number;
	/** The start of the line after the `\usepackage` that loads changes, at most `body`. */
	changes?: number;
	/** Whether the preamble holds the {@link inlineNotes} block. */
	inline: boolean;
	/** How many `\definechangesauthor` lines there are. */
	authors: number;
	ids: Set<string>;
}

function readPreamble(text: string): Preamble | undefined {
	const nodes = scan(text).children;
	const body = documentEnv(nodes)?.from;
	if (body === undefined) return undefined;
	const p: Preamble = {
		body,
		inline: text.slice(0, body).includes(inlineNotes[0] ?? ""),
		authors: 0,
		ids: new Set(),
	};
	for (const n of nodes) {
		if (n.from >= body) break;
		const arg = n.kind === "command" ? n.args[1] : undefined;
		if (n.kind !== "command" || !arg?.closed) continue;
		const value = text.slice(arg.from + 1, arg.to - 1);
		if (n.name === "usepackage" && p.changes === undefined) {
			if (value.split(",").some((name) => name.trim() === "changes")) {
				const eol = text.indexOf("\n", n.to);
				p.changes = eol < 0 ? body : Math.min(eol + 1, body);
			}
		} else if (n.name === "definechangesauthor") {
			p.authors++;
			p.ids.add(value.trim());
		}
	}
	return p;
}

// An edit that inserts `lines` at `at` as whole lines, with the line ending
// of the line before.
function insertLines(text: string, at: number, lines: string[]): Edit {
	const nl = text.lastIndexOf("\n", at - 1);
	const eol = nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
	const lead = at > 0 && text[at - 1] !== "\n" ? eol : "";
	return {
		from: at,
		to: at,
		insert: lead + lines.map((line) => line + eol).join(""),
	};
}

/**
 * Edits to the entry file's text so that `author` can write changes markup
 * and comments compile everywhere: `\usepackage{changes}` when no
 * uncommented `\usepackage[…]{…}` loads the package; the block that draws
 * comments inline where a margin note cannot go (see
 * {@link ensureInlineNotes}) when it is missing; and
 * `\definechangesauthor[name={…}, color=…]{<id>}` when that ID is not
 * declared yet. The package, the block and the author go on their own lines
 * immediately before `\begin{document}`, in that order, except that the
 * block goes on the line after a `\usepackage` that already loads changes.
 * The colour is the next one in a fixed palette of xcolor names, by how many
 * authors the preamble already declares. No edits when nothing is missing or
 * the text has no `\begin{document}`.
 *
 * The entry file is often not the file being edited: apply these edits to
 * the entry file's own text before (or together with) the first comment or
 * tracked change in any file of the project. `author.id` is used verbatim
 * and should be letters and digits; `author.name` is escaped.
 */
export function ensurePreamble(
	entryText: string,
	author: { id: string; name: string },
): Edit[] {
	const p = readPreamble(entryText);
	if (!p) return [];
	const edits: Edit[] = [];
	const lines: string[] = [];
	if (p.changes === undefined) {
		lines.push("\\usepackage{changes}");
		if (!p.inline) lines.push(...inlineNotes);
	} else if (!p.inline) {
		edits.push(insertLines(entryText, p.changes, inlineNotes));
	}
	if (!p.ids.has(author.id)) {
		const color = palette[p.authors % palette.length];
		lines.push(
			`\\definechangesauthor[name={${escapeComment(author.name)}}, color=${color}]{${author.id}}`,
		);
	}
	if (lines.length > 0) edits.push(insertLines(entryText, p.body, lines));
	return edits;
}

/**
 * The edit that adds only the block drawing comments inline where LaTeX
 * cannot place a margin note: on the line after the `\usepackage` that loads
 * changes, or else just before `\begin{document}`. For a manuscript that
 * already has comments and fails to build; {@link ensurePreamble} adds it
 * with the first comment. No edits when the block is there or the text has
 * no `\begin{document}`.
 */
export function ensureInlineNotes(entryText: string): Edit[] {
	const p = readPreamble(entryText);
	if (!p || p.inline) return [];
	return [insertLines(entryText, p.changes ?? p.body, inlineNotes)];
}

function documentEnv(nodes: Node[]): Env | undefined {
	return nodes.find((n): n is Env => n.kind === "env" && n.name === "document");
}

function refuse(reason: string): Outcome {
	return { ok: false, reason };
}

// Edits that keep `keep`, a range inside `change`, and drop the rest.
function unwrap(change: Change, keep: Range): Edit[] {
	return [
		{ from: change.from, to: keep.from, insert: "" },
		{ from: keep.to, to: change.to, insert: "" },
	];
}

function remove(range: Range): Edit {
	return { from: range.from, to: range.to, insert: "" };
}

/** `comment`: a `\highlight` around the range; `track`: `\added`, `\deleted` or `\replaced`. */
export type WrapKind = "comment" | "track";

const textCommands = new Set(
	"emph textbf textit texttt underline textsc textsuperscript textsubscript".split(
		" ",
	),
);

// Commands that break the build when they appear inside a changes macro.
const unsafeInside = new Set(
	"footnote url href item par part chapter section subsection subsubsection paragraph subparagraph caption input include subfile".split(
		" ",
	),
);

const cut =
	"The selection cuts through LaTeX markup. Select whole words or whole commands.";

/**
 * Why `range` of `text` cannot be wrapped in a `changes` macro so that the
 * file still compiles, as a sentence to show the user, or `undefined` when
 * it can. An empty range asks whether text can be inserted there.
 *
 * The range must lie in the document body (not the preamble), stay within
 * one paragraph, sit in prose (plain text, a plain `{…}` group, the argument
 * of a text style such as `\emph`, `\footnote`, `\caption` for a comment
 * (the {@link ensurePreamble} block draws it inline), the new text of
 * `\added` or `\replaced`, or the text of `\highlight` for tracking), and not
 * cut through a command, group, math, comment, or environment boundary, nor
 * sit in a list before its first `\item`. What
 * it covers must not include environments, displayed math, verbatim text,
 * LaTeX comments, a raw `&`, commands such as `\footnote`, `\item` or
 * `\section`, or other changes macros (for a comment: other comments). The
 * `changes` package fails to compile those combinations.
 */
export function whyNotWrap(
	text: string,
	range: Range,
	kind: WrapKind,
): string | undefined {
	const { from, to } = range;
	const root = scan(text);
	const body = documentEnv(root.children);
	if (body && !(from >= body.begin.to && to <= (body.end?.from ?? body.to))) {
		return "Comments and tracked changes work only in the document text, not in the preamble.";
	}
	// A line break counts with the blank space around it, so taking one line
	// break out of a blank line crosses the paragraph break too.
	let a = from;
	let b = to;
	if (text.slice(from, to).includes("\n")) {
		while (a > 0 && /\s/.test(text[a - 1] ?? "")) a--;
		while (b < text.length && /\s/.test(text[b] ?? "")) b++;
	}
	if (/\n[ \t\r]*\n/.test(text.slice(a, b))) {
		return "The selection spans a paragraph break. Select text within one paragraph.";
	}
	return within(text, root.children, range, kind);
}

function within(
	text: string,
	nodes: Node[],
	range: Range,
	kind: WrapKind,
): string | undefined {
	const { from, to } = range;
	for (const n of nodes) {
		if (n.from >= to || n.to <= from) continue;
		if (from <= n.from && n.to <= to) {
			const why = covered(text, n, kind);
			if (why) return why;
			continue;
		}
		// `n` straddles an end of the range or contains all of it.
		switch (n.kind) {
			case "text":
				continue;
			case "math":
				return "The selection is inside math. Select the whole formula instead.";
			case "comment":
				return "The selection is inside a LaTeX comment (a line part starting with %).";
			case "group":
				if (!n.bracket && n.closed && from > n.from && to < n.to) {
					return within(text, n.children, range, kind);
				}
				return cut;
			case "command": {
				const arg = n.args.find(
					(a) => a && !a.bracket && a.closed && from > a.from && to < a.to,
				);
				if (!arg) return changeOf(text, n) ? inChange : cut;
				if (!prose(text, n, arg.from, kind)) {
					return changeOf(text, n) ? inChange : notProse;
				}
				return within(text, arg.children, range, kind);
			}
			case "env":
				if (lists.has(n.name) && !afterFirstItem(n, from)) {
					return "The selection is in a list before its first item.";
				}
				if (n.end && from >= n.begin.to && to <= n.end.from) {
					return within(text, n.children, range, kind);
				}
				return "The selection crosses the start or end of a list, figure, or other environment.";
			default:
				return cut;
		}
	}
	return undefined;
}

const lists = new Set(["itemize", "enumerate", "description"]);

// Text in a list before its first `\item` does not compile.
function afterFirstItem(list: Env, at: number): boolean {
	const item = list.children.find(
		(n) => n.kind === "command" && n.name === "item",
	);
	return item !== undefined && at >= item.to;
}

const inChange =
	"The selection is inside another comment or tracked change, where a new one cannot go.";
const notProse =
	"The selection is inside a command argument that is not running text.";

// Whether the brace argument starting at `argFrom` of `cmd` is running text.
function prose(
	text: string,
	cmd: Command,
	argFrom: number,
	kind: WrapKind,
): boolean {
	if (textCommands.has(cmd.name)) return true;
	if (cmd.name === "footnote") return true;
	if (cmd.name === "caption") return kind === "comment";
	const change = changeOf(text, cmd);
	if (change?.text.from !== argFrom + 1) return false;
	if (change.kind === "added" || change.kind === "replaced") return true;
	return change.kind === "highlight" && kind === "track";
}

// Why a node wholly inside the range cannot be wrapped, if it cannot.
function covered(text: string, n: Node, kind: WrapKind): string | undefined {
	switch (n.kind) {
		case "text":
			return text.slice(n.from, n.to).includes("&")
				? "The selection includes a table column separator (&)."
				: undefined;
		case "comment":
			return "The selection includes a LaTeX comment (a line part starting with %).";
		case "verbatim":
			return "The selection includes verbatim text.";
		case "math":
			return n.display
				? "The selection includes a displayed equation."
				: undefined;
		case "env":
			return "The selection includes a whole list, figure, or other environment.";
		case "command": {
			if (unsafeInside.has(n.name)) {
				return `The selection includes \\${n.name}, which cannot be inside a comment or tracked change.`;
			}
			const change = changeOf(text, n);
			if (change && kind === "track") {
				return "The selection includes another tracked change or comment.";
			}
			if (
				change &&
				(change.kind === "highlight" ||
					change.kind === "comment" ||
					change.comment !== undefined)
			) {
				return "The selection includes another comment.";
			}
			break;
		}
	}
	if ("children" in n) {
		for (const child of n.children) {
			const why = covered(text, child, kind);
			if (why) return why;
		}
	}
	return undefined;
}
