import { expect, test } from "vitest";
import { findChanges } from "../latex/changes";
import { fixture } from "../latex/fixture";
import {
	acceptAll,
	acceptChange,
	addComment,
	addHighlight,
	applyEdits,
	type Edit,
	ensurePreamble,
	escapeComment,
	needsInlineNotes,
	type Outcome,
	rejectAll,
	rejectChange,
	resolveComment,
	unescapeComment,
	whyNotWrap,
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

test("a comment may go in a footnote or a caption, where the preamble block draws it inline", () => {
	const text = [
		"\\begin{document}",
		"Text\\footnote{foot words}.",
		"\\begin{figure}\\caption{cap words}\\end{figure}",
		"\\end{document}",
	].join("\n");
	for (const needle of ["foot words", "cap words"]) {
		expect(addComment(text, find(text, needle), "RR", "ok").ok, needle).toBe(
			true,
		);
	}
	expect(whyNotWrap(text, find(text, "foot words"), "track")).toBeUndefined();
	expect(whyNotWrap(text, find(text, "cap words"), "track")).toMatch(
		/not running text/,
	);
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

// The blocks ensurePreamble writes, as lines: the layout block, then the
// inline-notes block.
const layout = [
	"% Added by Revisions: draw highlights that wrap, and widen the page to give margin notes a column.",
	"\\edef\\RevisionsHighlight{\\csname Changes@optionhighlightmarkup\\endcsname}\\def\\RevisionsBackground{background}",
	"\\IfFileExists{tikzmarklibraryhighlighting.code.tex}{\\let\\RevisionsTikzmark\\relax}{}",
	"\\ifx\\RevisionsHighlight\\RevisionsBackground\\ifdefined\\sethighlightmarkup\\ifdefined\\AddToHook\\ifdefined\\RevisionsTikzmark",
	"\\usepackage{tikz}\\usetikzlibrary{tikzmark}\\usetikzmarklibrary{highlighting}\\newcount\\RevisionsHighlights",
	"\\tikzset{revisions highlight/.style 2 args={highlighter/initial height=#1,highlighter/final height=#1,highlighter/initial depth=#2,highlighter/final depth=#2,highlighter/initial offset=1pt,highlighter/final offset=1pt,highlighter/left margin=1pt,highlighter/right margin=1pt,rounded corners=1pt}}",
	"\\sethighlightmarkup{\\leavevmode\\global\\advance\\RevisionsHighlights1 \\xglobal\\colorlet{RevisionsHighlight\\the\\RevisionsHighlights}{authorcolor!30}\\edef\\RevisionsStart{\\noexpand\\StartHighlighting[fill=RevisionsHighlight\\the\\RevisionsHighlights,revisions highlight={\\the\\dimexpr.7\\baselineskip}{\\the\\dimexpr.3\\baselineskip}]}\\RevisionsStart#1\\StopHighlighting}",
	"\\fi\\fi\\fi\\fi",
	"\\ifdefined\\setuptodonotes\\ifdefined\\AddToHook",
	"\\setuptodonotes{size=\\footnotesize}",
	"\\AddToHook{cmd/@todonotes@drawMarginNoteWithLine/before}{\\ifdefined\\RevisionsNoteSeen\\else\\global\\let\\RevisionsNoteSeen\\relax\\immediate\\write\\csname @auxout\\endcsname{\\string\\global\\string\\let\\string\\RevisionsMarginNotes\\string\\relax}\\fi}% tells the next run",
	"\\AtBeginDocument{\\ifdefined\\RevisionsMarginNotes\\ifdim\\marginparwidth<2in \\setlength\\marginparwidth{2in}\\fi",
	"\\dimen0=\\dimexpr1.25in+\\hoffset+\\oddsidemargin+\\textwidth+\\marginparsep+\\marginparwidth\\relax",
	"\\ifdim\\paperwidth<\\dimen0 \\paperwidth=\\dimen0 \\fi\\ifdefined\\pdfpagewidth\\pdfpagewidth=\\paperwidth\\fi\\ifdefined\\pagewidth\\pagewidth=\\paperwidth\\fi\\fi}",
	"\\fi\\fi",
];
const inline = [
	"% Added by Revisions: draw comments inline where LaTeX cannot place a margin note.",
	"\\ifdefined\\setuptodonotes\\ifdefined\\AddToHook",
	"\\AddToHook{cmd/todo/before}{\\ifinner\\setuptodonotes{inline, inlinewidth=10em}\\fi}% boxes, table cells",
	"\\AddToHook{cmd/@arrayparboxrestore/after}{\\setuptodonotes{inline}}% floats, footnotes",
	"\\AddToHook{env/abstract/begin}{\\setuptodonotes{inline}}% abstracts",
	"\\AddToHook{env/frontmatter/begin}{\\setuptodonotes{inline}}% elsarticle title block",
	"\\fi\\fi",
];
const lines = (ls: string[], eol: string) => ls.map((l) => l + eol).join("");
const inlineBlock = (eol = "\n") => lines(inline, eol);
const block = (eol = "\n") => lines([...layout, ...inline], eol);

/** ensurePreamble's edits, failing the test if it refuses. */
function prep(text: string, author?: { id: string; name: string }): Edit[] {
	const outcome = ensurePreamble(text, author);
	if (!outcome.ok) throw new Error(outcome.reason);
	return outcome.edits;
}

const gale = { id: "GH", name: "Gale Harper" };

/** A manuscript whose preamble holds `blocks` and Gale's author line. */
const ready = (blocks = block(), eol = "\n") =>
	[
		"\\documentclass{article}",
		"\\usepackage{changes}",
		blocks.replace(/\r?\n$/, ""),
		"\\definechangesauthor[name={Gale Harper}, color=blue]{GH}",
		"\\begin{document}",
		"x",
		"\\end{document}",
		"",
	].join(eol);

test("Package not loaded: \\usepackage{changes}, the two blocks and the author go just before \\begin{document}", () => {
	const text = fixture("main.tex");
	const at = text.indexOf("\\begin{document}");
	const out = applyEdits(text, prep(text, { id: "RR", name: "Ryan R." }));
	expect(out).toBe(
		`${text.slice(0, at)}\\usepackage{changes}\n${block()}\\definechangesauthor[name={Ryan R.}, color=blue]{RR}\n${text.slice(at)}`,
	);
	expect(prep(out, { id: "RR", name: "Ryan R." })).toEqual([]);
});

test("New author: a preamble that loads changes gets only the author, in the next colour", () => {
	const text = [
		"\\documentclass{article}",
		"\\usepackage[final]{xcolor, changes}",
		block().trimEnd(),
		"\\definechangesauthor[name={Ada}, color=blue]{AB}",
		"% \\definechangesauthor{RR}",
		"\\begin{document}",
		"x",
		"\\end{document}",
	].join("\n");
	const out = applyEdits(text, prep(text, { id: "RR", name: "R_R & {co}" }));
	expect(out).toBe(
		text.replace(
			"\\begin{document}",
			"\\definechangesauthor[name={R\\_R \\& \\{co\\}}, color=red]{RR}\n\\begin{document}",
		),
	);
});

test("a preamble that loads changes with options but has no blocks gets them on the next line, once", () => {
	const text = [
		"\\documentclass{elsarticle}",
		"\\usepackage[markup=underlined, commentmarkup=todo]{xcolor,changes} % review",
		"\\usepackage{amsmath}",
		"\\definechangesauthor[name={Gale Harper}, color=blue]{GH}",
		"\\begin{document}",
		"x",
		"\\end{document}",
	].join("\n");
	const author = { id: "GH", name: "Gale Harper" };
	const out = applyEdits(text, prep(text, author));
	expect(out).toBe(text.replace("% review\n", `% review\n${block()}`));
	expect(prep(out, author)).toEqual([]);
	expect(needsInlineNotes(out)).toBe(false);
	// The failed build's repair has no author: both blocks, no author line.
	expect(needsInlineNotes(text)).toBe(true);
	expect(applyEdits(text, prep(text))).toBe(
		text.replace("% review\n", `% review\n${block()}`),
	);
});

test("a preamble with only the inline-notes block gets the layout block on the line after \\usepackage{changes}, once", () => {
	const text = [
		"\\documentclass{article}",
		"\\usepackage{changes}",
		inlineBlock().trimEnd(),
		"\\definechangesauthor[name={Gale Harper}, color=blue]{GH}",
		"\\begin{document}",
		"x",
		"\\end{document}",
	].join("\n");
	const author = { id: "GH", name: "Gale Harper" };
	const out = applyEdits(text, prep(text, author));
	expect(out).toBe(
		text.replace(
			"\\usepackage{changes}\n",
			`\\usepackage{changes}\n${lines(layout, "\n")}`,
		),
	);
	expect(prep(out, author)).toEqual([]);
});

test("the block keeps CRLF line endings and every existing byte", () => {
	const text =
		"\\documentclass{article}\r\n\\usepackage{changes}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n";
	const out = applyEdits(text, prep(text, { id: "RR", name: "R" }));
	const at = text.indexOf("\\begin{document}");
	expect(out).toBe(
		`${text.slice(0, at)}${block("\r\n")}\\definechangesauthor[name={R}, color=blue]{RR}\r\n${text.slice(at)}`,
	);
	const fresh =
		"\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n";
	expect(applyEdits(fresh, prep(fresh, { id: "RR", name: "R" }))).toBe(
		fresh.replace(
			"\\begin{document}",
			`\\usepackage{changes}\r\n${block("\r\n")}\\definechangesauthor[name={R}, color=blue]{RR}\r\n\\begin{document}`,
		),
	);
});

test("a \\usepackage{changes} on the \\begin{document} line gets the block on lines of its own", () => {
	const text =
		"\\documentclass{article}\\usepackage{changes}\\begin{document}x\\end{document}";
	expect(applyEdits(text, prep(text))).toBe(
		`\\documentclass{article}\\usepackage{changes}\n${block()}\\begin{document}x\\end{document}`,
	);
	expect(prep("no document here")).toEqual([]);
	expect(needsInlineNotes("no document here")).toBe(false);
});

test("a commented-out \\usepackage{changes} does not count, and odd layouts still get their own lines", () => {
	const text =
		"\\documentclass{article}\n% \\usepackage{changes}\n\\usepackage{x}\\begin{document}\nx\n\\end{document}";
	expect(applyEdits(text, prep(text, { id: "RR", name: "R" }))).toBe(
		`\\documentclass{article}\n% \\usepackage{changes}\n\\usepackage{x}\n\\usepackage{changes}\n${block()}\\definechangesauthor[name={R}, color=blue]{RR}\n\\begin{document}\nx\n\\end{document}`,
	);
	expect(prep("no document here", { id: "RR", name: "R" })).toEqual([]);
});

test("Reformatted block: indentation, line breaks, spacing after a command and % remarks are not changes", () => {
	const reformatted = [
		...layout.map((l) =>
			`  ${l}`
				// Split after a command and at an existing space.
				.replace("\\fi\\fi\\fi\\fi", "\\fi \\fi\n\\fi\\fi")
				.replace("<2in \\setlength", "<2in\n    \\setlength")
				.replace("% tells the next run", "% for the next run")
				.replace("{size=\\footnotesize}", "{size=\\footnotesize} % smaller"),
		),
		...inline.map((l) =>
			l.replace("% boxes, table cells", "").replace(/^\\fi\\fi$/, "\\fi\n\\fi"),
		),
	].join("\n");
	const text = ready(reformatted);
	expect(text).not.toBe(ready());
	expect(prep(text, gale)).toEqual([]);
	expect(needsInlineNotes(text)).toBe(false);
});

test("Changed block: a block that does something else is replaced whole, keeping every other byte", () => {
	const narrower = layout.map((l) => l.replaceAll("{2in}", "{1.5in}"));
	const noAbstract = inline.filter((l) => !l.includes("env/abstract"));
	const text = ready(lines([...narrower, ...noAbstract], "\n"));
	expect(needsInlineNotes(text)).toBe(true);
	expect(applyEdits(text, prep(text, gale))).toBe(ready());
	// A missing layout block goes in where the changed inline block starts.
	const lgn = ready(lines(noAbstract, "\n"));
	expect(applyEdits(lgn, prep(lgn, gale))).toBe(ready());
	// CRLF files keep CRLF.
	const crlf = ready(lines([...layout, ...noAbstract], "\r\n"), "\r\n");
	expect(applyEdits(crlf, prep(crlf, gale))).toBe(ready(block("\r\n"), "\r\n"));
});

test("Block without an end: a changed block with no closing \\fi\\fi is refused with its line", () => {
	const noEnd = ready(lines([...layout, ...inline.slice(0, -1)], "\n"));
	expect(ensurePreamble(noEnd, gale)).toEqual({
		ok: false,
		reason: expect.stringContaining("line 18"),
	});
	// The layout block's search stops at the inline block, which it never takes.
	const layoutNoEnd = ready(lines([...layout.slice(0, -1), ...inline], "\n"));
	expect(ensurePreamble(layoutNoEnd, gale)).toEqual({
		ok: false,
		reason: expect.stringContaining("line 3"),
	});
});

test("only a missing or changed inline-notes block needs the failed build's repair", () => {
	expect(needsInlineNotes(ready())).toBe(false);
	expect(needsInlineNotes(ready(lines(inline, "\n")))).toBe(false);
	expect(needsInlineNotes(ready(lines(layout, "\n")))).toBe(true);
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
