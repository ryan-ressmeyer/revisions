import { expect, test } from "vitest";
import { findChanges } from "../latex/changes";
import { fixture } from "../latex/fixture";
import {
	acceptAll,
	acceptChange,
	addComment,
	addHighlight,
	applyEdits,
	ensurePreamble,
	escapeComment,
	type Outcome,
	rejectAll,
	rejectChange,
	resolveComment,
	unescapeComment,
} from "./changes";

const doc = [
	"\\documentclass{article}",
	"\\usepackage{amsmath}",
	"\\begin{document}",
	"Plain words here with \\emph{emphasis inside} and $x + y$ math.",
	"",
	"Second paragraph \\added[id=AB]{added words} and \\deleted[id=AB]{gone words} end.",
	"\\highlight[id=AB, comment={old note}]{noted words} \\footnote{foot words}.",
	"\\begin{itemize}",
	"\\item one",
	"\\end{itemize}",
	"\\end{document}",
	"",
].join("\n");

// The range of `needle` in `text`, optionally widened by `before`/`after` chars.
function find(text: string, needle: string): { from: number; to: number } {
	const from = text.indexOf(needle);
	if (from < 0) throw new Error(`no ${needle}`);
	return { from, to: from + needle.length };
}

function applied(text: string, outcome: Outcome): string {
	if (!outcome.ok) throw new Error(outcome.reason);
	return applyEdits(text, outcome.edits);
}

test("Add comment: the selection is wrapped in a \\highlight with the author ID and comment", () => {
	const text = fixture("main.tex");
	const range = find(text, "small, rapid jumps");
	const out = applied(text, addComment(text, range, "RR", "Which jumps?"));
	const marked =
		"\\highlight[id=RR, comment={Which jumps?}]{small, rapid jumps}";
	expect(out).toBe(text.slice(0, range.from) + marked + text.slice(range.to));
});

test("Highlight: the selection is wrapped in a \\highlight with the author ID and no comment", () => {
	const text = fixture("main.tex");
	const range = find(text, "small, rapid jumps");
	const out = applied(text, addHighlight(text, range, "RR"));
	expect(out).toBe(
		`${text.slice(0, range.from)}\\highlight[id=RR]{small, rapid jumps}${text.slice(range.to)}`,
	);
	const [change] = findChanges(out);
	expect(change).toMatchObject({ kind: "highlight", author: "RR" });
	expect(change?.comment).toBeUndefined();
	// Remove is Resolve: the text stays byte for byte.
	expect(applyEdits(out, resolveComment(change as never))).toBe(text);
});

test("Highlight: refused for the same selections as a comment", () => {
	expect(addHighlight(doc, { from: 5, to: 5 }, "RR")).toMatchObject({
		ok: false,
	});
	for (const needle of ["x + y", "noted words} \\footnote", "\\usepackage"]) {
		const range = find(doc, needle);
		const a = addHighlight(doc, range, "RR");
		const b = addComment(doc, range, "RR", "note");
		expect(a.ok).toBe(false);
		expect(a).toEqual(b);
	}
});

test("a comment with any characters compiles-safe and round-trips", () => {
	const nasty = "100% of {this} & that_#1 \\ ~^$\nnext line\r\nand {unbalanced";
	expect(unescapeComment(escapeComment(nasty))).toBe(
		nasty.replace(/\r\n/g, "\n"),
	);
	const text = fixture("main.tex");
	const out = applied(
		text,
		addComment(text, find(text, "microsaccades"), "RR", nasty),
	);
	const [change] = findChanges(out);
	expect(change?.kind).toBe("highlight");
	expect(unescapeComment(change?.comment ?? "")).toBe(
		nasty.replace(/\r\n/g, "\n"),
	);
	expect(out.slice(change?.text.from, change?.text.to)).toBe("microsaccades");
});

test("escaped comments round-trip over random input", () => {
	const chars = "ab \\{}%#&_$^~\n[],=";
	let state = 7;
	for (let i = 0; i < 500; i++) {
		let s = "";
		for (let j = 0; j < 12; j++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			s += chars[state % chars.length];
		}
		const text = `\\begin{document}\nword\n\\end{document}`;
		const out = applied(text, addComment(text, find(text, "word"), "RR", s));
		const [change] = findChanges(out);
		expect(unescapeComment(change?.comment ?? "")).toBe(s);
	}
});

test("a comment is refused, with a reason, where it cannot be wrapped safely", () => {
	const refused: [string, { from: number; to: number }][] = [
		["empty selection", { from: 100, to: 100 }],
		["preamble", find(doc, "amsmath")],
		["cuts a group", find(doc, "with \\emph{emphasis")],
		["inside math", find(doc, "x + y")],
		["paragraph break", find(doc, "math.\n\nSecond")],
		["change markup", find(doc, "id=AB")],
		["deleted text", find(doc, "gone")],
		["highlighted text", find(doc, "noted")],
		[
			"contains a comment",
			find(doc, "end.\n\\highlight[id=AB, comment={old note}]{noted words}"),
		],
		["crosses an environment", find(doc, "one\n\\end{itemize}")],
		[
			"whole environment",
			find(doc, "\\begin{itemize}\n\\item one\n\\end{itemize}"),
		],
		["footnote text", find(doc, "foot words")],
	];
	for (const [label, range] of refused) {
		const r = addComment(doc, range, "RR", "note");
		expect(r.ok, label).toBe(false);
		if (!r.ok) expect(r.reason, label).toMatch(/^[A-Z].*\.$/);
	}
	expect(addComment(doc, find(doc, "Plain"), "RR", "  ").ok).toBe(false);
});

test("a comment may cover formatting, whole math, citations and tracked changes", () => {
	for (const needle of [
		"emphasis",
		"\\emph{emphasis inside} and $x + y$",
		"added words",
		"\\added[id=AB]{added words} and",
	]) {
		expect(addComment(doc, find(doc, needle), "RR", "ok").ok, needle).toBe(
			true,
		);
	}
	const text = fixture("main.tex");
	expect(
		addComment(text, find(text, "\\parencite{rolfs2009}"), "RR", "ok").ok,
	).toBe(true);
});

test("Resolve comment: the \\highlight is removed and its text kept byte for byte", () => {
	const inner = "a \\added[id=AB]{b}\r\n $x$ \\parencite{k}";
	const text = `Before \\highlight[id=RR, comment={why?}]{${inner}} after.`;
	const [change] = findChanges(text);
	if (!change) throw new Error("no change");
	expect(applyEdits(text, resolveComment(change))).toBe(
		`Before ${inner} after.`,
	);
});

test("resolving a standalone \\comment removes it entirely", () => {
	const text = "Before \\comment[id=RR]{a note} after.";
	const [change] = findChanges(text);
	if (!change) throw new Error("no change");
	expect(applyEdits(text, resolveComment(change))).toBe("Before  after.");
});

test("Package not loaded: \\usepackage{changes} and the author go just before \\begin{document}", () => {
	const text = fixture("main.tex");
	const at = text.indexOf("\\begin{document}");
	const out = applyEdits(
		text,
		ensurePreamble(text, { id: "RR", name: "Ryan R." }),
	);
	expect(out).toBe(
		`${text.slice(0, at)}\\usepackage{changes}\n\\definechangesauthor[name={Ryan R.}, color=blue]{RR}\n${text.slice(at)}`,
	);
	expect(ensurePreamble(out, { id: "RR", name: "Ryan R." })).toEqual([]);
});

test("New author: a preamble that loads changes gets only the author, in the next colour", () => {
	const text = [
		"\\documentclass{article}",
		"\\usepackage[final]{xcolor, changes}",
		"\\definechangesauthor[name={Ada}, color=blue]{AB}",
		"% \\definechangesauthor{RR}",
		"\\begin{document}",
		"x",
		"\\end{document}",
	].join("\n");
	const out = applyEdits(
		text,
		ensurePreamble(text, { id: "RR", name: "R_R & {co}" }),
	);
	expect(out).toContain(
		"% \\definechangesauthor{RR}\n\\definechangesauthor[name={R\\_R \\& \\{co\\}}, color=red]{RR}\n\\begin{document}",
	);
	expect(out).not.toContain("\\usepackage{changes}");
});

test("a commented-out \\usepackage{changes} does not count, and odd layouts still get their own lines", () => {
	const text =
		"\\documentclass{article}\n% \\usepackage{changes}\n\\usepackage{x}\\begin{document}\nx\n\\end{document}";
	expect(applyEdits(text, ensurePreamble(text, { id: "RR", name: "R" }))).toBe(
		"\\documentclass{article}\n% \\usepackage{changes}\n\\usepackage{x}\n\\usepackage{changes}\n\\definechangesauthor[name={R}, color=blue]{RR}\n\\begin{document}\nx\n\\end{document}",
	);
	expect(ensurePreamble("no document here", { id: "RR", name: "R" })).toEqual(
		[],
	);
});

test("accepting or rejecting one change keeps the right text byte for byte", () => {
	const cases: [string, string, string][] = [
		["\\added[id=RR]{new\r\n text}", "new\r\n text", ""],
		["\\deleted[id=RR]{old\r\n text}", "", "old\r\n text"],
		[
			"\\replaced[id=RR]{fresh $x$}{stale \\cite{k}}",
			"fresh $x$",
			"stale \\cite{k}",
		],
	];
	for (const [macro, accepted, rejected] of cases) {
		const text = `a ${macro} b`;
		const [change] = findChanges(text);
		if (!change) throw new Error(macro);
		expect(applyEdits(text, acceptChange(change))).toBe(`a ${accepted} b`);
		expect(applyEdits(text, rejectChange(change))).toBe(`a ${rejected} b`);
	}
	const [comment] = findChanges("\\highlight[id=RR, comment={c}]{h}");
	if (!comment) throw new Error("no comment");
	expect(acceptChange(comment)).toEqual([]);
	expect(rejectChange(comment)).toEqual([]);
});

test("Accept all: every tracked change is applied, nested ones included, and comments stay", () => {
	const text =
		"A \\added[id=RR]{x \\deleted[id=AB]{y} z} B \\deleted[id=RR]{p \\added[id=AB]{q}} C \\replaced[id=RR]{n \\added[id=AB]{m}}{o \\deleted[id=AB]{d}} D \\highlight[id=RR, comment={c}]{h \\added[id=AB]{i}} \\comment[id=RR]{note}";
	expect(applyEdits(text, acceptAll(text))).toBe(
		"A x  z B  C n m D \\highlight[id=RR, comment={c}]{h i} \\comment[id=RR]{note}",
	);
	expect(applyEdits(text, rejectAll(text))).toBe(
		"A  B p  C o d D \\highlight[id=RR, comment={c}]{h } \\comment[id=RR]{note}",
	);
	expect(acceptAll(fixture("main.tex"))).toEqual([]);
});
