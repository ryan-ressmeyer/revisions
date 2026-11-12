import { expect, test } from "vitest";
import { marginNoteTrouble } from "./notes";

const floatsLost = [{ message: "LaTeX Error: Float(s) lost." }];

const main = [
	"\\documentclass{elsarticle}", // 1
	"\\usepackage{changes}",
	"\\definechangesauthor{GH}",
	"\\begin{document}",
	"\\begin{frontmatter}", // 5
	"\\begin{abstract}",
	"An \\highlight[id=GH, comment={In the abstract}]{abstract}.",
	"\\end{abstract}",
	"\\end{frontmatter}",
	"\\section{A \\highlight[id=GH, comment={In a title}]{title}}", // 10
	"Body \\highlight[id=GH, comment={In the body}]{text}.",
	"\\begin{itemize}",
	"\\item An \\highlight[id=GH, comment={In a list}]{item}.",
	"\\end{itemize}",
	"\\begin{figure}", // 15
	"\\highlight[id=GH, comment={In a figure, 50\\%}]{word}",
	"\\highlight[id=GH]{no comment}",
	"\\caption{A \\highlight[id=GH, comment={In a caption}]{caption}.}",
	"\\end{figure}",
	"Text\\footnote{A \\highlight[id=GH, comment={In a footnote}]{note}.}.", // 20
	"\\begin{minipage}{3cm}\\comment[id=GH]{In a box}\\end{minipage}",
	"\\begin{tabular}{l}",
	"\\added[id=GH, comment={In a table}]{cell} \\\\",
	"\\end{tabular}",
	"\\end{document}", // 25
].join("\n");

test("a comment where a margin note cannot go is explained and named, with its file and line", () => {
	const trouble = marginNoteTrouble(floatsLost, [
		{ path: "main.tex", text: main },
		{
			path: "sections/methods.tex",
			text: "\\begin{table}\\highlight[id=GH, comment={Elsewhere}]{x}\\end{table}\n",
		},
		{ path: "refs.bib", text: "@misc{k, note={\\comment{not LaTeX}}}" },
	]);
	expect(trouble?.explanation).toMatch(
		/comment sits where LaTeX cannot place a margin note.*abstract of some journal templates, a caption, a footnote, a table, or a boxed area/s,
	);
	expect(trouble?.comments).toEqual([
		{
			path: "main.tex",
			line: 7,
			place: "the abstract",
			text: "In the abstract",
		},
		{ path: "main.tex", line: 16, place: "a figure", text: "In a figure, 50%" },
		{ path: "main.tex", line: 18, place: "a caption", text: "In a caption" },
		{ path: "main.tex", line: 20, place: "a footnote", text: "In a footnote" },
		{ path: "main.tex", line: 21, place: "a box", text: "In a box" },
		{ path: "main.tex", line: 23, place: "a table", text: "In a table" },
		{
			path: "sections/methods.tex",
			line: 1,
			place: "a table",
			text: "Elsewhere",
		},
	]);
});

test("Not in outer par mode is explained the same way", () => {
	const trouble = marginNoteTrouble(
		[{ message: "./main.tex:18: LaTeX Error: Not in outer par mode." }],
		[{ path: "main.tex", text: main }],
	);
	expect(trouble?.comments).toHaveLength(6);
});

test("nothing to explain for other errors, or for a document without comments", () => {
	const files = [{ path: "main.tex", text: main }];
	expect(
		marginNoteTrouble([{ message: "Undefined control sequence." }], files),
	).toBeUndefined();
	const plain =
		"\\begin{document}\\begin{figure}\\highlight[id=GH]{x}\\end{figure}\\end{document}";
	expect(
		marginNoteTrouble(floatsLost, [{ path: "main.tex", text: plain }]),
	).toBeUndefined();
});

test("comments only in ordinary text still get the explanation, with no names", () => {
	const text =
		"\\begin{document}Body \\highlight[id=GH, comment={Fine}]{text}.\\end{document}";
	const trouble = marginNoteTrouble(floatsLost, [{ path: "main.tex", text }]);
	expect(trouble?.comments).toEqual([]);
	expect(trouble?.explanation).toMatch(/could not tell which comment/);
});
