// Builds the fixture manuscript with every kind of markup this module writes,
// with the real `changes` package. Skipped when TeX is not installed.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	addComment,
	addHighlight,
	applyEdits,
	type Edit,
	ensureInlineNotes,
	ensurePreamble,
} from "./changes";
import { trackEdit } from "./track";

const hasLatexmk = spawnSync("latexmk", ["-v"]).status === 0;
const title = `the fixture with comments, tracked changes and new authors compiles${hasLatexmk ? "" : " (skipped: latexmk is not on PATH)"}`;

class Doc {
	constructor(public text: string) {}

	at(needle: string): number {
		const i = this.text.indexOf(needle);
		if (i < 0) throw new Error(`no ${needle}`);
		return i;
	}

	apply(edits: Edit[]): void {
		this.text = applyEdits(this.text, edits);
	}

	comment(needle: string, author: string, note: string): void {
		const from = this.at(needle);
		const r = addComment(
			this.text,
			{ from, to: from + needle.length },
			author,
			note,
		);
		if (!r.ok) throw new Error(`${needle}: ${r.reason}`);
		this.apply(r.edits);
	}

	highlight(needle: string, author: string): void {
		const from = this.at(needle);
		const r = addHighlight(
			this.text,
			{ from, to: from + needle.length },
			author,
		);
		if (!r.ok) throw new Error(`${needle}: ${r.reason}`);
		this.apply(r.edits);
	}

	// Tracked keystrokes from `cursor`: text, "backspace" or "delete".
	keys(cursor: number, strokes: string[], author = "RR"): number {
		for (const key of strokes) {
			const edit =
				key === "backspace"
					? { from: cursor - 1, to: cursor, insert: "" }
					: key === "delete"
						? { from: cursor, to: cursor + 1, insert: "" }
						: { from: cursor, to: cursor, insert: key };
			cursor = this.edit(edit, author, key === "delete");
		}
		return cursor;
	}

	// A tracked edit; returns the cursor.
	edit(edit: Edit, author = "RR", forward = false): number {
		const r = trackEdit(this.text, edit, author, forward);
		if (!r.tracked) throw new Error(`untracked: ${JSON.stringify(edit)}`);
		this.apply(r.edits);
		return r.cursor;
	}

	replace(needle: string, insert: string, author = "RR"): number {
		const from = this.at(needle);
		return this.edit({ from, to: from + needle.length, insert }, author);
	}
}

test.skipIf(!hasLatexmk)(
	title,
	() => {
		const dir = mkdtempSync(join(tmpdir(), "revisions-changes-"));
		cpSync(new URL("../../../../testdata/manuscript", import.meta.url), dir, {
			recursive: true,
		});
		const main = new Doc(readFileSync(join(dir, "main.tex"), "utf8"));
		main.apply(
			ensurePreamble(main.text, { id: "RR", name: "Ryan_R & {co} 100%" }),
		);
		main.apply(ensurePreamble(main.text, { id: "AB", name: "Ada" }));

		main.comment(
			"$g = R_{\\text{post}} / R_{\\text{pre}}$ summarizes",
			"RR",
			"100% of {this} & that_#1 \\ ~^$\nsecond line",
		);
		main.comment("\\textcite{rucci2015} argue", "AB", "Is this fair?");
		// Typing inside commented text nests an \added in the \highlight.
		main.keys(main.at(" argue}") + " argue".length, [..." strongly"]);
		main.replace(
			"small, rapid jumps called \\emph{microsaccades} \\parencite{rolfs2009}",
			"",
		);
		main.replace("of contrast $c$", "");
		const typed = main.replace("drift", "w");
		main.keys(typed, [..."ander"]);
		main.keys(main.at("never still") + 5, Array(5).fill("backspace"));
		main.keys(main.at("not written yet") + 4, Array(8).fill("delete"));
		main.keys(main.at("still.") + 6, [
			..." Truly so, $x^2$ ",
			"\\cite{rolfs2009}",
			".",
		]);
		main.replace("larger", "bigger", "AB");
		main.highlight("steady fixation", "AB");
		main.replace("Low", "");
		writeFileSync(join(dir, "main.tex"), main.text);

		const methodsPath = join(dir, "sections", "methods.tex");
		const methods = new Doc(readFileSync(methodsPath, "utf8"));
		methods.replace("velocity threshold", "speed criterion", "AB");
		methods.comment("below \\vdeg{1}", "AB", "Why 1 degree?");
		writeFileSync(methodsPath, methods.text);

		const out = join(dir, "out");
		const run = spawnSync(
			"latexmk",
			[
				"-norc",
				"-pdf",
				"-interaction=nonstopmode",
				"-halt-on-error",
				"-no-shell-escape",
				`-outdir=${out}`,
				"main.tex",
			],
			{ cwd: dir, encoding: "utf8" },
		);
		const log = run.status === 0 ? "" : readLog(join(out, "main.log"));
		expect(run.status, `${main.text}\n${log}`).toBe(0);
	},
	120_000,
);

function readLog(path: string): string {
	try {
		return readFileSync(path, "utf8").split("\n").slice(-40).join("\n");
	} catch {
		return `no log at ${path}`;
	}
}

// Comments where LaTeX cannot place a margin note. The changes package draws
// a comment as a todonotes margin note, which fails inside floats, boxes,
// table cells, footnotes and boxed abstracts unless the preamble block that
// ensurePreamble writes draws it inline there.

const engines = ["pdflatex", "xelatex", "lualatex"].filter(
	(e) => spawnSync(e, ["--version"]).status === 0,
);
const hasClass = (cls: string) =>
	spawnSync("kpsewhich", [`${cls}.cls`], { encoding: "utf8" }).stdout.trim() !==
	"";

// Test-only hooks on todonotes' two ways of drawing a note print each
// comment's text to the log, so a test can tell an inline note from a margin
// note. They rely on internal names of todonotes and changes.
const probes = String.raw`\makeatletter
\AddToHook{cmd/@todonotes@drawInlineNote/before}{\typeout{PROBE inline: \Changes@highlight@comment}}
\AddToHook{cmd/@todonotes@drawMarginNoteWithLine/before}{\typeout{PROBE margin: \Changes@highlight@comment}}
\makeatother
`;

interface Built {
	status: number | null;
	log: string;
	/** How each comment was drawn, by its text: "inline", "margin" or both. */
	notes: Map<string, Set<string>>;
}

function build(engine: string, text: string): Built {
	const dir = mkdtempSync(join(tmpdir(), "revisions-notes-"));
	writeFileSync(
		join(dir, "main.tex"),
		text.replace("\\begin{document}", `${probes}\\begin{document}`),
	);
	const run = spawnSync(
		engine,
		[
			"-interaction=nonstopmode",
			"-halt-on-error",
			"-no-shell-escape",
			"main.tex",
		],
		{
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, max_print_line: "10000" },
		},
	);
	let log = "";
	try {
		log = readFileSync(join(dir, "main.log"), "utf8");
	} catch {}
	const notes = new Map<string, Set<string>>();
	for (const [, how, comment] of log.matchAll(
		/^PROBE (inline|margin): (.*)$/gm,
	)) {
		const key = comment?.trim() ?? "";
		notes.set(key, (notes.get(key) ?? new Set()).add(how ?? ""));
	}
	return { status: run.status, log, notes };
}

const gale = { id: "GH", name: "Gale Harper" };

/**
 * A document with a comment in each place and, after each, a comment in
 * body text. `rich` places get their comment through addComment, as the
 * editor adds it; the others (box arguments, which the editor refuses as not
 * running text) are written by hand, as in the source view.
 */
function placesDoc(
	cls: string,
	packages: string,
	places: { name: string; tex: string; rich: boolean }[],
): Doc {
	const doc = new Doc(
		[
			`\\documentclass{${cls}}`,
			packages,
			"\\begin{document}",
			...places.flatMap((p) => [
				p.tex.replace("WORDS", `in ${p.name} words`),
				"",
				`Body text after-${p.name} words.`,
				"",
			]),
			"\\end{document}",
			"",
		].join("\n"),
	);
	doc.apply(ensurePreamble(doc.text, gale));
	for (const p of places) {
		if (p.rich) doc.comment(`in ${p.name} words`, "GH", p.name);
		else
			doc.text = doc.text.replace(
				`in ${p.name} words`,
				`\\highlight[id=GH, comment={${p.name}}]{in ${p.name} words}`,
			);
		doc.comment(`after-${p.name} words`, "GH", `after ${p.name}`);
	}
	return doc;
}

function expectInlineThenMargin(built: Built, names: string[], text: string) {
	expect(
		built.status,
		`${text}\n${built.log.split("\n").slice(-40).join("\n")}`,
	).toBe(0);
	for (const name of names) {
		expect(built.notes.get(name), name).toEqual(new Set(["inline"]));
		expect(built.notes.get(`after ${name}`), `after ${name}`).toEqual(
			new Set(["margin"]),
		);
	}
}

const articlePlaces = [
	{ name: "figure", tex: "\\begin{figure}WORDS.\\end{figure}", rich: true },
	{ name: "figure*", tex: "\\begin{figure*}WORDS.\\end{figure*}", rich: true },
	{ name: "table", tex: "\\begin{table}WORDS.\\end{table}", rich: true },
	{ name: "table*", tex: "\\begin{table*}WORDS.\\end{table*}", rich: true },
	{
		name: "caption",
		tex: "\\begin{figure}\\centering X\\caption{WORDS.}\\end{figure}",
		rich: true,
	},
	{
		name: "tabular",
		tex: "\\begin{tabular}{ll}a & WORDS\\\\\n\\end{tabular}",
		rich: true,
	},
	{
		name: "p column",
		tex: "\\begin{tabular}{p{4cm}l}WORDS & b\\\\\n\\end{tabular}",
		rich: true,
	},
	{
		name: "tabular*",
		tex: "\\begin{tabular*}{\\linewidth}{ll}a & WORDS\\\\\n\\end{tabular*}",
		rich: true,
	},
	{
		name: "tabularx",
		tex: "\\begin{tabularx}{\\linewidth}{lX}a & WORDS\\\\\n\\end{tabularx}",
		rich: true,
	},
	{
		name: "longtable",
		tex: "\\begin{longtable}{ll}a & WORDS\\\\\n\\end{longtable}",
		rich: true,
	},
	{
		name: "minipage",
		tex: "\\begin{minipage}{5cm}WORDS.\\end{minipage}",
		rich: true,
	},
	{ name: "footnote", tex: "Text\\footnote{WORDS.} more.", rich: true },
	{
		name: "minipage footnote",
		tex: "\\begin{minipage}{5cm}Text\\footnote{WORDS.}\\end{minipage}",
		rich: true,
	},
	{
		name: "abstract",
		tex: "\\begin{abstract}WORDS.\\end{abstract}",
		rich: true,
	},
	{ name: "parbox", tex: "\\parbox{5cm}{WORDS.}", rich: false },
	{ name: "fbox", tex: "\\fbox{WORDS.}", rich: false },
	{ name: "mbox", tex: "\\mbox{WORDS.}", rich: false },
	{ name: "colorbox", tex: "\\colorbox{yellow}{WORDS.}", rich: false },
];

describe.each(engines)("with %s", (engine) => {
	test("a comment in each place that cannot hold a margin note compiles inline, and body comments after it stay in the margin", () => {
		const doc = placesDoc(
			"article",
			"\\usepackage{tabularx,longtable}",
			articlePlaces,
		);
		expectInlineThenMargin(
			build(engine, doc.text),
			articlePlaces.map((p) => p.name),
			doc.text,
		);
	}, 120_000);

	test.skipIf(!hasClass("elsarticle"))(
		"elsarticle: comments in the abstract and keywords in frontmatter compile inline",
		() => {
			const doc = placesDoc("elsarticle", "", [
				{
					name: "abstract",
					tex: "\\begin{frontmatter}\\title{T}\\begin{abstract}WORDS.\\end{abstract}\\begin{keyword}in keywords words\\end{keyword}\\end{frontmatter}",
					rich: true,
				},
			]);
			doc.comment("in keywords words", "GH", "keywords");
			const built = build(engine, doc.text);
			expectInlineThenMargin(built, ["abstract"], doc.text);
			expect(built.notes.get("keywords")).toEqual(new Set(["inline"]));
		},
		120_000,
	);

	test.skipIf(!hasClass("amsart"))(
		"amsart: a comment in the abstract compiles inline",
		() => {
			const places = [
				{
					name: "abstract",
					tex: "\\title{T}\\begin{abstract}WORDS.\\end{abstract}\\maketitle",
					rich: true,
				},
			];
			const doc = placesDoc("amsart", "", places);
			expectInlineThenMargin(build(engine, doc.text), ["abstract"], doc.text);
		},
		120_000,
	);
});

const owner = [
	"\\documentclass{article}",
	"\\usepackage{changes}",
	"\\definechangesauthor[name={Gale Harper}, color=blue]{GH}",
	"\\begin{document}",
	"\\begin{figure}\\highlight[id=GH, comment={figure}]{Trace}.\\end{figure}",
	"Body \\highlight[id=GH, comment={body}]{text}.",
	"\\end{document}",
	"",
].join("\n");

test.skipIf(!engines.includes("pdflatex"))(
	"without the block a comment in a figure stops the build with Float(s) lost, and adding the block fixes it",
	() => {
		const broken = build("pdflatex", owner);
		expect(broken.status).not.toBe(0);
		expect(broken.log).toContain("Float(s) lost");
		const fixed = applyEdits(owner, ensureInlineNotes(owner));
		const built = build("pdflatex", fixed);
		expect(built.status, built.log).toBe(0);
		expect(built.notes.get("figure")).toEqual(new Set(["inline"]));
		expect(built.notes.get("body")).toEqual(new Set(["margin"]));
	},
	60_000,
);

test.skipIf(!engines.includes("pdflatex"))(
	"the block does nothing without todonotes or the hook system, and breaks nothing",
	() => {
		// A figure and an abstract with no comment run the block's hooks.
		const body = owner.replace(
			/\\begin\{figure\}.*\n/,
			"\\begin{abstract}An abstract.\\end{abstract}\n\\begin{figure}A figure.\\end{figure}\n",
		);
		const withBlock = applyEdits(body, ensureInlineNotes(body));
		const variants = {
			"commentmarkup=margin": withBlock.replace(
				"\\usepackage{changes}",
				"\\usepackage[commentmarkup=margin]{changes}",
			),
			final: withBlock.replace(
				"\\usepackage{changes}",
				"\\usepackage[final]{changes}",
			),
			// Hides \AddToHook from the block only; the test's probes need it.
			"LaTeX before 2020-10": withBlock
				.replace(
					"% Added by Revisions",
					"\\let\\HiddenAddToHook\\AddToHook\\let\\AddToHook\\undefined\n% Added by Revisions",
				)
				.replace("\\fi\\fi\n", "\\fi\\fi\n\\let\\AddToHook\\HiddenAddToHook\n"),
		};
		for (const [label, text] of Object.entries(variants)) {
			const built = build("pdflatex", text);
			expect(built.status, `${label}\n${built.log}`).toBe(0);
		}
	},
	60_000,
);
