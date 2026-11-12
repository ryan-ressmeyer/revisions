// Test support only: reads the fixture manuscript from testdata/.
import { readFileSync } from "node:fs";

const paths = [
	"main.tex",
	"supplement.tex",
	"sections/methods.tex",
	"stats.tex",
	"refs.bib",
];

/** Every text file of `testdata/manuscript`, with repository-relative paths. */
export const fixtureFiles = paths.map((path) => ({
	path,
	text: readFileSync(
		new URL(`../../../../testdata/manuscript/${path}`, import.meta.url),
		"utf8",
	),
}));

export function fixture(path: string): string {
	const file = fixtureFiles.find((f) => f.path === path);
	if (!file) throw new Error(`no fixture file ${path}`);
	return file.text;
}

/** Deterministic pseudo-random LaTeX-flavoured garbage. */
export function garbage(seed: number, length: number): string {
	const pieces = [
		"\\",
		"{",
		"}",
		"[",
		"]",
		"$",
		"$$",
		"%",
		"&",
		"\n",
		"\n\n",
		" ",
		"a",
		"*",
		"\\begin{itemize}",
		"\\end{itemize}",
		"\\begin{equation}",
		"\\end{equation}",
		"\\begin{tabular}{lc}",
		"\\end{tabular}",
		"\\begin{figure}",
		"\\end{figure}",
		"\\begin{verbatim}",
		"\\end{verbatim}",
		"\\begin{document}",
		"\\end{document}",
		"\\begin",
		"\\end",
		"\\item",
		"\\section",
		"\\textbf",
		"\\cite",
		"\\ref",
		"\\label",
		"\\added[id=a,comment={b",
		"\\replaced",
		"\\highlight",
		"\\includegraphics",
		"\\caption",
		"\\verb|",
		"\\(",
		"\\)",
		"\\[",
		"\\]",
		"\\\\",
		"\\multicolumn{2}{c}",
		"\\documentclass",
		"\u0000",
		"\ud83d",
		"é",
		"constructor",
		"\\constructor",
		"\\__proto__",
	];
	let state = seed >>> 0 || 1;
	let out = "";
	while (out.length < length) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out += pieces[state % pieces.length];
	}
	return out;
}
