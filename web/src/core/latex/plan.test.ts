import { describe, expect, test } from "vitest";
import { fixture, fixtureFiles, garbage } from "./fixture";
import {
	buildPlan,
	joinSoftBreak,
	type Plan,
	type Primitive,
	revealSelection,
} from "./plan";
import { buildIndex, type SourceFile } from "./project";

const bib: SourceFile = { path: "refs.bib", text: "@article{a,\n}" };

function planOf(text: string, others: SourceFile[] = [bib]): Plan {
	return buildPlan(text, buildIndex([{ path: "main.tex", text }, ...others]));
}

/** Each primitive as `[what, source it covers]`. */
function show(text: string, primitives: Primitive[]): [string, string][] {
	return primitives.map((p) => {
		const what =
			p.type === "mark"
				? p.class
				: p.type === "widget"
					? p.widget.kind
					: p.type;
		return [what, text.slice(p.from, p.to)];
	});
}

function widgets(plan: Plan) {
	return plan.primitives.flatMap((p) => (p.type === "widget" ? [p] : []));
}

function widgetAt(text: string, plan: Plan, source: string) {
	const from = text.indexOf(source);
	const hit = widgets(plan).find((p) => p.from <= from && from < p.to);
	if (!hit) throw new Error(`no widget over ${source}`);
	return hit;
}

describe("sections and emphasis", () => {
	test("a heading hides its command and styles the title in place", () => {
		const text = "\\section{A \\textbf{b} c}";
		const plan = planOf(text);
		expect(show(text, plan.primitives)).toEqual([
			["hide", "\\section{"],
			["heading", "A \\textbf{b} c"],
			["hide", "\\textbf{"],
			["bold", "b"],
			["hide", "}"],
			["hide", "}"],
		]);
		expect(plan.primitives[1]).toMatchObject({ attrs: { level: "2" } });
		expect(plan.groups).toEqual([
			{ id: 0, from: 0, to: text.length },
			{ id: 1, from: 11, to: 21 },
		]);
	});

	test("every sectioning level, starred and with a short title", () => {
		const names = [
			"part",
			"chapter",
			"section",
			"subsection",
			"subsubsection",
			"paragraph",
			"subparagraph",
		];
		names.forEach((name, level) => {
			const text = `\\${name}*[short]{Long}`;
			const plan = planOf(text);
			expect(show(text, plan.primitives)).toEqual([
				["hide", `\\${name}*[short]{`],
				["heading", "Long"],
				["hide", "}"],
			]);
			expect(plan.primitives[1]).toMatchObject({
				attrs: { level: String(level) },
			});
		});
	});

	test("each emphasis command has its class", () => {
		const classes = {
			emph: "emph",
			textbf: "bold",
			textit: "italic",
			texttt: "mono",
			underline: "underline",
			textsc: "smallcaps",
			textsuperscript: "superscript",
			textsubscript: "subscript",
		};
		for (const [name, cls] of Object.entries(classes)) {
			const text = `x \\${name}{y} z`;
			expect(show(text, planOf(text).primitives)).toEqual([
				["hide", `\\${name}{`],
				[cls, "y"],
				["hide", "}"],
			]);
		}
	});
});

describe("lists", () => {
	const text = [
		"Intro",
		"\\begin{itemize}",
		"  \\item one",
		"  \\item two",
		"  \\begin{enumerate}",
		"    \\item deep",
		"    \\item[x] labelled",
		"    \\item last",
		"  \\end{enumerate}",
		"\\end{itemize}",
		"After",
	].join("\n");
	const plan = planOf(text);

	test("items become markers that know their list, depth and number", () => {
		// A labelled \item does not step the counter, as in LaTeX.
		expect(widgets(plan).map((p) => p.widget)).toEqual([
			{ kind: "item", list: "itemize", depth: 1, number: 1 },
			{ kind: "item", list: "itemize", depth: 1, number: 2 },
			{ kind: "item", list: "enumerate", depth: 2, number: 1 },
			{ kind: "item", list: "enumerate", depth: 2, number: 2 },
		]);
		expect(show(text, widgets(plan)).every(([, src]) => src === "\\item")).toBe(
			true,
		);
	});

	test("begin and end lines disappear, a custom label is styled in place", () => {
		// A hidden line takes the line break before it, so the visible line
		// after it keeps its own line decoration in CodeMirror.
		const rest = plan.primitives.filter(
			(p) => p.type === "hide" || p.type === "mark",
		);
		expect(show(text, rest)).toEqual([
			["hide", "\n\\begin{itemize}"],
			["hide", "\n  \\begin{enumerate}"],
			["hide", "\\item["],
			["item-label", "x"],
			["hide", "]"],
			["hide", "\n  \\end{enumerate}"],
			["hide", "\n\\end{itemize}"],
		]);
	});

	test("each visible list line carries its nesting depth once", () => {
		const lines = plan.primitives.flatMap((p) =>
			p.type === "line"
				? [[text.slice(p.from, text.indexOf("\n", p.from)), p.attrs.depth]]
				: [],
		);
		expect(lines).toEqual([
			["  \\item one", "1"],
			["  \\item two", "1"],
			["    \\item deep", "2"],
			["    \\item[x] labelled", "2"],
			["    \\item last", "2"],
		]);
	});

	test("a description list styles its terms", () => {
		const src = "\\begin{description}\\item[Term] text\\end{description}";
		expect(show(src, planOf(src).primitives)).toEqual([
			["hide", "\\begin{description}"],
			["hide", "\\item["],
			["item-label", "Term"],
			["hide", "]"],
			["hide", "\\end{description}"],
		]);
	});
});

describe("citations, references and labels", () => {
	test("citation forms carry notes, star and per-key resolution", () => {
		const text =
			"\\cite{a} \\citep[see][p.~3]{a, zz} \\textcite[ch. 2]{a} \\citeauthor*{a}";
		const plan = planOf(text);
		expect(widgets(plan).map((p) => p.widget)).toEqual([
			{
				kind: "cite",
				command: "cite",
				star: false,
				keys: [{ key: "a", resolved: true }],
			},
			{
				kind: "cite",
				command: "citep",
				star: false,
				pre: "see",
				post: "p.~3",
				keys: [
					{ key: "a", resolved: true },
					{ key: "zz", resolved: false },
				],
			},
			{
				kind: "cite",
				command: "textcite",
				star: false,
				post: "ch. 2",
				keys: [{ key: "a", resolved: true }],
			},
			{
				kind: "cite",
				command: "citeauthor",
				star: true,
				keys: [{ key: "a", resolved: true }],
			},
		]);
		expect(show(text, widgets(plan))[1]).toEqual([
			"cite",
			"\\citep[see][p.~3]{a, zz}",
		]);
	});

	test("every citation command is recognised", () => {
		const names =
			"cite citep citet parencite textcite autocite footcite citeauthor citeyear";
		for (const name of names.split(" ")) {
			const text = `\\${name}{a}`;
			expect(widgets(planOf(text))[0]?.widget).toMatchObject({
				kind: "cite",
				command: name,
			});
		}
	});

	test("references resolve against labels, labels become chips", () => {
		const text =
			"\\label{s} \\linelabel{t} \\ref{s} \\cref{s,t} \\eqref{nope} \\Cref{s} \\pageref{s} \\autoref{s} \\nameref{s} \\lineref{t}";
		const plan = planOf(text);
		expect(
			widgets(plan)
				.slice(0, 5)
				.map((p) => p.widget),
		).toEqual([
			{ kind: "label", command: "label", key: "s" },
			{ kind: "label", command: "linelabel", key: "t" },
			{ kind: "ref", command: "ref", keys: [{ key: "s", resolved: true }] },
			{
				kind: "ref",
				command: "cref",
				keys: [
					{ key: "s", resolved: true },
					{ key: "t", resolved: true },
				],
			},
			{
				kind: "ref",
				command: "eqref",
				keys: [{ key: "nope", resolved: false }],
			},
		]);
		expect(widgets(plan)).toHaveLength(10);
	});
});

describe("math", () => {
	const text = [
		"Inline $a^2$ and \\(b\\).",
		"\\[",
		"  c = d",
		"\\]",
		"Text $$e$$ more.",
		"\\begin{equation}",
		"  f \\label{eq:f}",
		"\\end{equation}",
		"  \\begin{multline*}",
		" g \\\\ h",
		"\\end{multline*}",
		"",
	].join("\n");
	const plan = planOf(text);

	test("each form is a math widget with KaTeX-ready TeX", () => {
		expect(
			widgets(plan).map((p) => [text.slice(p.from, p.to), p.widget, !!p.block]),
		).toEqual([
			["$a^2$", { kind: "math", tex: "a^2", display: false }, false],
			["\\(b\\)", { kind: "math", tex: "b", display: false }, false],
			[
				"\\[\n  c = d\n\\]",
				{ kind: "math", tex: "c = d", display: true },
				true,
			],
			["$$e$$", { kind: "math", tex: "e", display: true }, false],
			[
				"\\begin{equation}\n  f \\label{eq:f}\n\\end{equation}",
				{
					kind: "math",
					tex: "\\begin{equation}\n  f \n\\end{equation}",
					display: true,
				},
				true,
			],
			[
				"  \\begin{multline*}\n g \\\\ h\n\\end{multline*}",
				{
					kind: "math",
					tex: "\\begin{gathered}\n g \\\\ h\n\\end{gathered}",
					display: true,
				},
				true,
			],
		]);
	});

	test("the label inside an equation still resolves", () => {
		const src = `${text}\\eqref{eq:f}`;
		expect(widgets(planOf(src)).at(-1)?.widget).toMatchObject({
			keys: [{ key: "eq:f", resolved: true }],
		});
	});
});

describe("symbols", () => {
	test("control symbols and ties print as their characters", () => {
		const text = "60\\% of A\\&B, Section~2 \\emph{a~b} \\unknown\\@ $a~b$";
		const plan = planOf(text);
		const symbols = widgets(plan).map((p) => [
			text.slice(p.from, p.to),
			p.widget.kind === "symbol" ? p.widget.text : p.widget.kind,
		]);
		expect(symbols).toEqual([
			["\\%", "%"],
			["\\&", "&"],
			["~", " "],
			["~", " "],
			["$a~b$", "math"],
		]);
	});
});

describe("figures and tables", () => {
	test("a figure keeps its image and caption, and loses its scaffolding", () => {
		const text = [
			"\\begin{figure}[ht]",
			"  \\centering",
			"  \\includegraphics[width=0.6\\linewidth]{figures/trace.png}",
			"  \\caption{Mean \\emph{eye} position \\cite{a}.}",
			"  \\label{fig:trace}",
			"\\end{figure}",
			"",
		].join("\n");
		const plan = planOf(text);
		expect(show(text, plan.primitives)).toEqual([
			["hide", "\\begin{figure}[ht]"],
			["hide", "\n  \\centering"],
			["image", "  \\includegraphics[width=0.6\\linewidth]{figures/trace.png}"],
			["hide", "\\caption{"],
			["caption", "Mean \\emph{eye} position \\cite{a}."],
			["hide", "\\emph{"],
			["emph", "eye"],
			["hide", "}"],
			["cite", "\\cite{a}"],
			["hide", "}"],
			["label", "\\label{fig:trace}"],
			["hide", "\n\\end{figure}"],
		]);
		expect(widgets(plan)[0]).toMatchObject({
			block: true,
			widget: {
				kind: "image",
				path: "figures/trace.png",
				options: "width=0.6\\linewidth",
			},
		});
		expect(plan.primitives[4]).toMatchObject({ attrs: { float: "figure" } });
	});

	test("a tabular is one widget of rows, cells and inline fragments", () => {
		const text = [
			"\\begin{tabular}{l|c r}",
			"  \\toprule",
			"  Name & \\textbf{Gain} & $x^2$ \\\\",
			"  \\midrule",
			"  \\multicolumn{2}{c}{Both \\cite{a}} & 60\\% \\\\[2pt]",
			"  A~B & \\vdeg{5} & \\ref{t} \\\\",
			"  \\bottomrule",
			"\\end{tabular}",
		].join("\n");
		const plan = planOf(text);
		expect(plan.primitives).toHaveLength(1);
		expect(plan.primitives[0]).toMatchObject({
			type: "widget",
			from: 0,
			to: text.length,
			block: true,
		});
		expect(widgets(plan)[0]?.widget).toEqual({
			kind: "table",
			align: ["l", "c", "r"],
			rows: [
				{
					ruleAbove: true,
					cells: [
						{ content: [{ kind: "text", text: "Name", styles: [] }] },
						{ content: [{ kind: "text", text: "Gain", styles: ["bold"] }] },
						{ content: [{ kind: "math", tex: "x^2", display: false }] },
					],
				},
				{
					ruleAbove: true,
					cells: [
						{
							span: 2,
							content: [
								{ kind: "text", text: "Both ", styles: [] },
								{
									kind: "cite",
									command: "cite",
									star: false,
									keys: [{ key: "a", resolved: true }],
								},
							],
						},
						{ content: [{ kind: "text", text: "60%", styles: [] }] },
					],
				},
				{
					ruleBelow: true,
					cells: [
						{ content: [{ kind: "text", text: "A\u00a0B", styles: [] }] },
						{ content: [{ kind: "raw", text: "\\vdeg{5}" }] },
						{
							content: [
								{
									kind: "ref",
									command: "ref",
									keys: [{ key: "t", resolved: false }],
								},
							],
						},
					],
				},
			],
		});
	});

	test("the fixture table has four rows of three cells", () => {
		const text = fixture("main.tex");
		const table = widgets(buildPlan(text, buildIndex(fixtureFiles))).find(
			(p) => p.widget.kind === "table",
		)?.widget;
		if (table?.kind !== "table") throw new Error("no table");
		expect(table.rows.map((r) => r.cells.length)).toEqual([3, 3, 3, 3]);
		expect(table.rows[3]?.cells[2]?.content).toEqual([
			{ kind: "text", text: "1.37", styles: [] },
		]);
	});

	test("column specs, partial rules and nested styles in cells", () => {
		const text =
			"x \\begin{tabular}{@{}p{3cm}*{2}{c}|r@{}} a & \\textbf{b \\emph{c}} & \\& \\\\ \\cmidrule(lr){2-3} d \\end{tabular}";
		const table = widgets(planOf(text))[0];
		expect(table?.block).toBe(false);
		expect(table?.widget).toEqual({
			kind: "table",
			align: ["l", "c", "c", "r"],
			rows: [
				{
					cells: [
						{ content: [{ kind: "text", text: "a", styles: [] }] },
						{
							content: [
								{ kind: "text", text: "b ", styles: ["bold"] },
								{ kind: "text", text: "c", styles: ["bold", "emph"] },
							],
						},
						{ content: [{ kind: "text", text: "&", styles: [] }] },
					],
				},
				{
					ruleAbove: true,
					cells: [{ content: [{ kind: "text", text: "d", styles: [] }] }],
				},
			],
		});
	});
});

describe("changes markup", () => {
	const text =
		"\\added[id=RR]{new \\textbf{b}} \\deleted{old} \\replaced[id=AB,comment={why}]{n}{o} \\highlight[id=RR,comment={c, d}]{h} \\comment{note}";
	const plan = planOf(text);

	test("arguments are styled in place and the markup is hidden", () => {
		expect(show(text, plan.primitives)).toEqual([
			["hide", "\\added[id=RR]{"],
			["added", "new \\textbf{b}"],
			["hide", "\\textbf{"],
			["bold", "b"],
			["hide", "}"],
			["hide", "}"],
			["hide", "\\deleted{"],
			["deleted", "old"],
			["hide", "}"],
			["hide", "\\replaced[id=AB,comment={why}]{"],
			["added", "n"],
			["hide", "}{"],
			["deleted", "o"],
			["hide", "}"],
			["hide", "\\highlight[id=RR,comment={c, d}]{"],
			["highlight", "h"],
			["hide", "}"],
			["hide", "\\comment{"],
			["comment", "note"],
			["hide", "}"],
		]);
		expect(plan.primitives[10]).toMatchObject({
			attrs: { change: "replaced", author: "AB", comment: "why" },
		});
	});

	test("Markup hidden: inserted text reads plainly and deleted text, old text and notes are hidden", () => {
		const clean = buildPlan(
			text,
			buildIndex([{ path: "main.tex", text }, bib]),
			{ markup: false },
		);
		expect(show(text, clean.primitives)).toEqual([
			["hide", "\\added[id=RR]{"],
			["hide", "\\textbf{"],
			["bold", "b"],
			["hide", "}"],
			["hide", "}"],
			["hide", "\\deleted{old}"],
			["hide", "\\replaced[id=AB,comment={why}]{"],
			["hide", "}{o}"],
			["hide", "\\highlight[id=RR,comment={c, d}]{"],
			["hide", "}"],
			["hide", "\\comment{note}"],
		]);
		// Hidden text never reveals, like the markup around it.
		const after = { from: text.indexOf("\\deleted"), to: text.length };
		expect(revealSelection(clean, [after])).toEqual(clean);
		expect(clean.changes).toEqual(plan.changes);
	});

	test("the plan lists each change with its group for the buttons", () => {
		expect(
			plan.changes.map((c) => [
				c.kind,
				c.author,
				c.comment,
				text.slice(c.text.from, c.text.to),
				c.old && text.slice(c.old.from, c.old.to),
			]),
		).toEqual([
			["added", "RR", undefined, "new \\textbf{b}", undefined],
			["deleted", undefined, undefined, "old", undefined],
			["replaced", "AB", "why", "n", "o"],
			["highlight", "RR", "c, d", "h", undefined],
			["comment", undefined, undefined, "note", undefined],
		]);
		for (const c of plan.changes) {
			expect(plan.groups[c.group]).toEqual({
				id: c.group,
				from: c.from,
				to: c.to,
			});
		}
	});
});

describe("soft line breaks", () => {
	const body = (lines: string[]) =>
		`\\documentclass{article}\n\\begin{document}\n${lines.join("\n")}\n\\end{document}\n`;
	// The text of each line that ends in a soft break.
	const softAfter = (text: string) =>
		planOf(text)
			.primitives.flatMap((p) =>
				p.type === "widget" && p.widget.kind === "softbreak" ? [p] : [],
			)
			.map((p) => {
				expect(text.slice(p.from, p.to)).toBe("\n");
				expect(p.group).toBe(-1);
				return text.slice(text.lastIndexOf("\n", p.from - 1) + 1, p.from);
			});

	test("a single line break inside a paragraph flows, with a mark at the join", () => {
		expect(
			softAfter(
				body(["One line", "  two \\emph{line}", "three.", "", "Next."]),
			),
		).toEqual(["One line", "  two \\emph{line}"]);
	});

	test("hard breaks stay: \\\\, comments, block commands, blank lines", () => {
		expect(
			softAfter(
				body([
					"Forced\\\\",
					"break \\\\[2pt]",
					"here % a note",
					"after a comment",
					"\\section{Title}",
					"Text",
					"\\label{sec:a}",
					"Text again",
					"\\begin{itemize}",
					"\\item one",
					"  continued",
					"\\item two",
					"\\end{itemize}",
					"After",
					"\\[ x \\]",
					"Closing",
				]),
			),
		).toEqual(["\\item one"]);
	});

	test("never inside display math, verbatim, tables or the preamble", () => {
		const text = [
			"\\documentclass{article}",
			"\\usepackage{a}",
			"\\usepackage{b}",
			"\\begin{document}",
			"\\begin{equation}",
			"a",
			"b",
			"\\end{equation}",
			"\\begin{verbatim}",
			"x",
			"y",
			"\\end{verbatim}",
			"\\begin{tabular}{l}",
			"x \\\\",
			"y",
			"\\end{tabular}",
			"\\end{document}",
			"",
		].join("\n");
		expect(softAfter(text)).toEqual([]);
	});

	test("Deleting the mark joins the lines with exactly one space", () => {
		const text = body(["one  ", "   two"]);
		const nl = text.indexOf("one") + 5;
		expect(text[nl]).toBe("\n");
		const back = joinSoftBreak(text, { from: nl, to: nl + 1, insert: "" });
		expect(back && applyAll(text, back.edits)).toBe(body(["one two"]));
		expect(back?.cursor).toBe(text.indexOf("one") + 4);
		const fwd = joinSoftBreak(text, { from: nl, to: nl + 1, insert: "" }, true);
		expect(fwd?.cursor).toBe(text.indexOf("one") + 3);

		const tight = body(["one", "two"]);
		const at = tight.indexOf("one") + 3;
		const joined = joinSoftBreak(tight, { from: at, to: at + 1, insert: "" });
		expect(joined && applyAll(tight, joined.edits)).toBe(body(["one two"]));

		// Not a soft break, or not exactly the mark: nothing to decide.
		const hard = body(["one", "", "two"]);
		const h = hard.indexOf("one") + 3;
		expect(joinSoftBreak(hard, { from: h, to: h + 1, insert: "" })).toBe(
			undefined,
		);
		expect(
			joinSoftBreak(tight, { from: at - 1, to: at + 1, insert: "" }),
		).toBeUndefined();
	});
});

function applyAll(
	text: string,
	edits: { from: number; to: number; insert: string }[],
) {
	let out = "";
	let at = 0;
	for (const e of edits) {
		out += text.slice(at, e.from) + e.insert;
		at = e.to;
	}
	return out + text.slice(at);
}

describe("preamble and body", () => {
	test("nothing before \\begin{document} is decorated", () => {
		const text = fixture("main.tex");
		const plan = buildPlan(text, buildIndex(fixtureFiles));
		const start =
			text.indexOf("\\begin{document}") + "\\begin{document}".length;
		expect(plan.bodyStart).toBe(start);
		expect(plan.primitives.length).toBeGreaterThan(40);
		expect(plan.primitives.every((p) => p.from >= start)).toBe(true);
		expect(plan.groups.every((g) => g.from >= start)).toBe(true);
	});

	test("a file with no \\documentclass is all body", () => {
		const text = fixture("sections/methods.tex");
		const plan = buildPlan(text, buildIndex(fixtureFiles));
		expect(plan.bodyStart).toBe(0);
		expect(show(text, plan.primitives).slice(0, 3)).toEqual([
			["hide", "\\section{"],
			["heading", "Methods"],
			["hide", "}"],
		]);
	});

	test("a preamble without a document body has no decorations", () => {
		const text = "\\documentclass{article}\n\\title{\\textbf{T}}\n";
		const plan = planOf(text);
		expect(plan.bodyStart).toBe(text.length);
		expect(plan.primitives).toEqual([]);
	});
});

describe("scenarios", () => {
	const main = fixture("main.tex");
	const plan = buildPlan(main, buildIndex(fixtureFiles));

	test("Unknown macro: an unrecognised command gets no decorations", () => {
		const text = "Stimuli subtended \\vdeg{0.5} of \\mystery[a]{b}{c}.";
		expect(planOf(text).primitives).toEqual([]);

		const from = main.indexOf("\\vdeg{0.5}");
		const to = from + "\\vdeg{0.5}".length;
		expect(from).toBeGreaterThan(plan.bodyStart);
		expect(plan.primitives.filter((p) => p.from < to && p.to > from)).toEqual(
			[],
		);
	});

	test("Cursor entry: a selection inside a display equation reveals only that equation", () => {
		const equation = widgetAt(main, plan, "\\begin{equation}");
		const align = widgetAt(main, plan, "\\begin{align}");
		const inline = widgetAt(main, plan, "$c$");
		expect(equation.widget).toMatchObject({ kind: "math", display: true });

		const cursor = main.indexOf("g(c) = 1");
		const revealed = revealSelection(plan, [{ from: cursor, to: cursor }]);
		expect(
			revealed.primitives.filter(
				(p) => p.type !== "line" && p.group === equation.group,
			),
		).toEqual([]);
		expect(revealed.primitives).toContain(align);
		expect(revealed.primitives).toContain(inline);
		expect(revealed.primitives).toHaveLength(plan.primitives.length - 1);
	});

	test("Unresolved citation: keys and labels resolve against the repository", () => {
		const keys = (source: string) => {
			const w = widgetAt(main, plan, source).widget;
			return w.kind === "cite" || w.kind === "ref" ? w.keys : [];
		};
		expect(keys("\\cite{missing2019}")).toEqual([
			{ key: "missing2019", resolved: false },
		]);
		expect(keys("\\parencite{rolfs2009}")).toEqual([
			{ key: "rolfs2009", resolved: true },
		]);
		expect(keys("\\cite{rucci2015, rolfs2009}")).toEqual([
			{ key: "rucci2015", resolved: true },
			{ key: "rolfs2009", resolved: true },
		]);
		expect(keys("\\ref{sec:missing}")).toEqual([
			{ key: "sec:missing", resolved: false },
		]);
		expect(keys("\\ref{sec:results}")).toEqual([
			{ key: "sec:results", resolved: true },
		]);

		const methods = fixture("sections/methods.tex");
		const child = buildPlan(methods, buildIndex(fixtureFiles));
		expect(
			widgetAt(methods, child, "\\textcite{engbert2003}").widget,
		).toMatchObject({ keys: [{ key: "engbert2003", resolved: true }] });
	});
});

describe("revealSelection", () => {
	const text = "\\section{A \\textbf{b} c} tail \\emph{e}";
	const plan = planOf(text);
	const hidden = (p: Plan) =>
		show(
			text,
			p.primitives.filter((x) => x.type === "hide"),
		).map(([, src]) => src);

	test("a cursor in nested content reveals every construct around it", () => {
		const at = text.indexOf("b}");
		expect(hidden(revealSelection(plan, [{ from: at, to: at }]))).toEqual([
			"\\emph{",
			"}",
		]);
	});

	test("a cursor in the outer construct leaves the inner one rendered", () => {
		expect(hidden(revealSelection(plan, [{ from: 9, to: 9 }]))).toEqual([
			"\\textbf{",
			"}",
			"\\emph{",
			"}",
		]);
	});

	test("touching either edge counts, one step away does not", () => {
		const from = text.indexOf("\\emph");
		const edge = revealSelection(plan, [{ from, to: from }]);
		expect(hidden(edge)).not.toContain("\\emph{");
		const end = revealSelection(plan, [{ from: text.length, to: text.length }]);
		expect(hidden(end)).not.toContain("\\emph{");
		const away = revealSelection(plan, [{ from: from - 1, to: from - 1 }]);
		expect(away.primitives).toEqual(plan.primitives);
	});

	test("styling stays while the source is revealed", () => {
		const all = revealSelection(plan, [{ from: 0, to: text.length }]);
		expect(show(text, all.primitives)).toEqual([
			["heading", "A \\textbf{b} c"],
			["bold", "b"],
			["emph", "e"],
		]);
	});

	test("several selection ranges each reveal their constructs", () => {
		const revealed = revealSelection(plan, [
			{ from: 2, to: 2 },
			{ from: text.length - 1, to: text.length - 1 },
		]);
		expect(hidden(revealed)).toEqual(["\\textbf{", "}"]);
	});

	test("changes markup stays hidden while the cursor is in it; what it holds reveals", () => {
		const text = "a \\added[id=X]{n \\emph{e}} \\replaced[id=X]{n}{o} b";
		const plan = planOf(text);
		const hidden = (p: Plan) =>
			show(
				text,
				p.primitives.filter((x) => x.type === "hide"),
			).map(([, src]) => src);
		const at = text.indexOf("e}");
		expect(hidden(revealSelection(plan, [{ from: at, to: at }]))).toEqual([
			"\\added[id=X]{",
			"}",
			"\\replaced[id=X]{",
			"}{",
			"}",
		]);
		expect(
			revealSelection(plan, [{ from: 0, to: text.length }]).primitives.filter(
				(p) => p.type === "hide",
			).length,
		).toBe(5);
	});
});

describe("tolerance", () => {
	const index = buildIndex(fixtureFiles);

	// Replaced ranges must not overlap, or the editor cannot apply them.
	function wellFormed(text: string): string | undefined {
		const plan = buildPlan(text, index);
		let last = plan.bodyStart;
		let from = 0;
		for (const p of plan.primitives) {
			if (p.from < from) return "not sorted";
			from = p.from;
			if (p.from > p.to || p.to > text.length) return "out of bounds";
			if (p.type === "hide" || p.type === "widget") {
				if (p.from < last) return "replaced ranges overlap";
				last = p.to;
			}
			if (p.type !== "line" && p.group !== -1 && !plan.groups[p.group])
				return "no group";
		}
		return undefined;
	}

	test("half-typed constructs stay raw", () => {
		const cases = [
			"\\textbf{abc",
			"\\section",
			"\\cite{",
			"\\cite[p. 2",
			"\\ref",
			"\\added[id=x]",
			"\\replaced{new}",
			"$x",
			"\\[ x",
			"\\begin{equation} x",
			"\\begin{itemize} \\item a",
			"\\begin{tabular}{ll} a & b",
			"\\includegraphics",
			"\\item stray",
			"\\end{itemize}",
		];
		for (const text of cases) {
			expect([text, planOf(text).primitives]).toEqual([text, []]);
		}
	});

	test("every prefix of the fixture plans cleanly", () => {
		const text = fixture("main.tex");
		for (let i = 0; i <= text.length; i++) {
			const problem = wellFormed(text.slice(0, i));
			if (problem) throw new Error(`prefix ${i}: ${problem}`);
		}
	});

	test("generated garbage plans cleanly", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const text = garbage(seed, 600);
			const problem = wellFormed(text);
			if (problem) throw new Error(`seed ${seed}: ${problem}`);
		}
	});

	test("a 200 KB document plans quickly", () => {
		const main = fixture("main.tex");
		const start = main.indexOf("\\begin{document}");
		const end = main.indexOf("\\end{document}");
		const body = main.slice(start + "\\begin{document}".length, end);
		const big = (n: number) =>
			`${main.slice(0, start)}\\begin{document}${body.repeat(
				Math.ceil(200_000 / body.length),
			)}% ${n}\n\\end{document}\n`;
		expect(big(0).length).toBeGreaterThan(200_000);

		const times: number[] = [];
		for (let n = 0; n < 12; n++) {
			const text = big(n);
			const t0 = performance.now();
			const plan = buildPlan(text, index);
			times.push(performance.now() - t0);
			expect(plan.primitives.length).toBeGreaterThan(5000);
		}
		const median = times.sort((a, b) => a - b)[6] ?? Number.POSITIVE_INFINITY;
		console.log(
			`buildPlan, ${big(0).length} chars: median ${median.toFixed(1)} ms`,
		);
		// The target is well under 50 ms; the bound is loose for slow CI.
		expect(median).toBeLessThan(150);
	});
});
