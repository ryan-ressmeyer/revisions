import { describe, expect, test } from "vitest";
import { type Macro, macroValue, mathMacros } from "./macros";
import { buildIndex, definedMacros, type SourceFile } from "./project";

/** The macros `main.tex` defines, with `others` in the project. */
function defined(main: string, others: SourceFile[] = []) {
	const index = buildIndex([{ path: "main.tex", text: main }, ...others]);
	return definedMacros(index, "main.tex", "main.tex");
}

const doc = (preamble: string, body = "") =>
	`\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe("collecting definitions", () => {
	test("every form of \\newcommand, \\renewcommand, \\providecommand and \\def", () => {
		const macros = defined(
			doc(
				[
					"\\newcommand{\\Units}{962}",
					"\\newcommand*{\\Sessions}{19}",
					"\\newcommand\\Bare{bare}",
					"\\newcommand{\\Spaced} {x}",
					"\\renewcommand{\\Rset}{\\mathbb{R}}",
					"\\providecommand{\\Note}[1]{\\textbf{[#1]}}",
					"\\newcommand{\\Pair}[2][a]{(#1, #2)}",
					"\\newcommand{\\Ci}{[-0.009, +0.004]} % trailing comment",
					"\\DeclareRobustCommand{\\Edit}[1]{{\\color{red}#1}}",
					"\\def\\Simple{s}",
					"\\def\\Who#1{{\\color{orange}$\\mathtt{Who:}$ {#1}}}",
					"\\def\\Two#1#2{#2#1}",
				].join("\n"),
			),
		);
		expect(Object.fromEntries(macros)).toEqual({
			Units: { params: 0, body: "962" },
			Sessions: { params: 0, body: "19" },
			Bare: { params: 0, body: "bare" },
			Spaced: { params: 0, body: "x" },
			Rset: { params: 0, body: "\\mathbb{R}" },
			Note: { params: 1, body: "\\textbf{[#1]}" },
			Pair: { params: 2, optional: "a", body: "(#1, #2)" },
			Ci: { params: 0, body: "[-0.009, +0.004]" },
			Edit: { params: 1, body: "{\\color{red}#1}" },
			Simple: { params: 0, body: "s" },
			Who: { params: 1, body: "{\\color{orange}$\\mathtt{Who:}$ {#1}}" },
			Two: { params: 2, body: "#2#1" },
		});
	});

	test("braces, escapes and comments inside a body are balanced as TeX reads them", () => {
		const macros = defined(
			doc("\\newcommand{\\A}{a\\}b{c}% }\n d}\n\\newcommand{\\B}[1][x]{y}"),
		);
		expect(macros.get("A")?.body).toBe("a\\}b{c}% }\n d");
		expect(macros.get("B")).toEqual({ params: 1, optional: "x", body: "y" });
	});

	test("files pulled in with \\input count, in the order TeX reads them, and a later definition wins", () => {
		const main = doc(
			"\\newcommand{\\A}{main}\n\\input{stats}\n\\renewcommand{\\C}{main}\n\\providecommand{\\D}{main}",
		);
		const stats: SourceFile = {
			path: "stats.tex",
			text: "\\renewcommand{\\A}{stats}\n\\newcommand{\\B}{12}\n\\newcommand{\\C}{stats}\n\\newcommand{\\D}{stats}",
		};
		const macros = defined(main, [stats]);
		expect(macros.get("A")?.body).toBe("stats");
		expect(macros.get("B")?.body).toBe("12");
		expect(macros.get("C")?.body).toBe("main");
		// \providecommand keeps a definition that already exists.
		expect(macros.get("D")?.body).toBe("stats");
	});

	test("an included file sees the entry file's macros; a file outside it sees only its own", () => {
		const files: SourceFile[] = [
			{ path: "main.tex", text: doc("\\newcommand{\\A}{1}", "\\input{sec}") },
			{ path: "sec.tex", text: "\\A" },
			{ path: "other.tex", text: doc("\\newcommand{\\B}{2}") },
		];
		const index = buildIndex(files);
		expect([...definedMacros(index, "main.tex", "sec.tex").keys()]).toEqual([
			"A",
		]);
		expect([...definedMacros(index, "main.tex", "other.tex").keys()]).toEqual([
			"B",
		]);
		expect([...definedMacros(index, "", "sec.tex").keys()]).toEqual([]);
	});

	test("definitions in comments, verbatim, math or a group are not collected", () => {
		const macros = defined(
			doc(
				[
					"% \\newcommand{\\A}{1}",
					"\\begin{verbatim}\\newcommand{\\B}{2}\\end{verbatim}",
					"$\\def\\C{3}$",
					"{\\def\\D{4}}",
					"\\pdfstringdefDisableCommands{\\def\\E#1{#1}}",
				].join("\n"),
			),
		);
		expect([...macros.keys()]).toEqual([]);
	});

	test("malformed and unsupported forms are skipped without harm", () => {
		const macros = defined(
			doc(
				[
					"\\newcommand{\\A}",
					"\\newcommand{\\B}[x]{y}",
					"\\newcommand{\\C}[0][d]{y}",
					"\\def\\E#2{misordered}",
					"\\def\\F#1.{delimited}",
					"\\newcommand{\\G H}{two names}",
					"\\newcommand{\\Ok}{fine}",
					// Last: like TeX, an unclosed body swallows the rest of the file.
					"\\newcommand{\\D}{unclosed",
				].join("\n"),
			),
		);
		expect([...macros.keys()]).toEqual(["Ok"]);
	});

	test("hostile definitions do not hang: an enormous body is ignored and recursion is cut", () => {
		const huge = `\\newcommand{\\Huge}{${"x".repeat(1_000_000)}}`;
		const unclosed = `\\newcommand{\\Open}{${"{".repeat(200_000)}`;
		const start = performance.now();
		const macros = defined(
			doc(
				`${huge}\n\\newcommand{\\Loop}{\\Loop}\n\\def\\Ping{\\Pong}\\def\\Pong{\\Ping}\n\\newcommand{\\Hash}[1]{#2 # ##}\n${unclosed}`,
			),
		);
		expect(macros.has("Huge")).toBe(false);
		expect(macros.has("Open")).toBe(false);
		expect(mathMacros("\\Loop + \\Ping", macros)).toBeUndefined();
		// `#` misuse goes to KaTeX as written, which reports it as an error.
		expect(mathMacros("\\Hash{1}", macros)).toEqual({
			"\\Hash": "\\@secondoftwo{#1}{#2 # ##}",
		});
		expect(performance.now() - start).toBeLessThan(2000);
	});
});

describe("macros for KaTeX", () => {
	const table = new Map<string, Macro>([
		["Cpsth", { params: 0, body: "\\Sigma_{\\text{PSTH}}" }],
		["Units", { params: 0, body: "962" }],
		["Outer", { params: 0, body: "\\Cpsth + \\Inner" }],
		["Inner", { params: 1, body: "#1^2" }],
		["Unused", { params: 2, body: "#2" }],
		["Opt", { params: 2, optional: "d", body: "#1/#2" }],
	]);

	test("only the macros a formula uses, directly or through others", () => {
		expect(mathMacros("x + y", table)).toBeUndefined();
		expect(mathMacros("n=\\Units", table)).toEqual({ "\\Units": "962" });
		expect(mathMacros("\\Outer", table)).toEqual({
			"\\Outer": "\\Cpsth + \\Inner",
			"\\Cpsth": "\\Sigma_{\\text{PSTH}}",
			"\\Inner": "#1^2",
		});
	});

	test("a parameter the body does not use is still taken as an argument", () => {
		expect(mathMacros("\\Unused{a}{b}", table)).toEqual({
			"\\Unused": "\\@secondoftwo{#1#2}{#2}",
		});
	});

	test("an optional parameter takes its default; an explicit one fails as an unknown macro", () => {
		expect(mathMacros("\\Opt{x}", table)).toEqual({
			"\\Opt": "\\@ifnextchar[{\\Opt@optional}{\\Opt@default}",
			"\\Opt@default": "d/#1",
		});
	});

	test("a formula whose macros would expand to a huge text gets none", () => {
		const blow = new Map<string, Macro>([
			["A", { params: 0, body: "\\B".repeat(500) }],
			["B", { params: 0, body: "y".repeat(1000) }],
		]);
		expect(mathMacros("\\A", blow)).toBeUndefined();
		expect(mathMacros("\\B", blow)).toEqual({ "\\B": "y".repeat(1000) });
	});
});

describe("values drawn in prose", () => {
	test("a zero-parameter macro of plain text or a number is a value", () => {
		expect(macroValue({ params: 0, body: "962" })).toBe("962");
		expect(macroValue({ params: 0, body: " [-0.009,\n +0.004] " })).toBe(
			"[-0.009, +0.004]",
		);
		expect(macroValue({ params: 0, body: "three" })).toBe("three");
	});

	test("anything that needs typesetting, takes parameters, or is empty is not", () => {
		for (const body of ["\\mathbb{R}", "$x$", "10\\%", "a_b", "{19}", "", " "])
			expect(macroValue({ params: 0, body })).toBeUndefined();
		expect(macroValue({ params: 1, body: "1" })).toBeUndefined();
	});
});
