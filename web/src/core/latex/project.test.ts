import { describe, expect, test } from "vitest";
import { fixtureFiles } from "./fixture";
import { buildIndex, includedFiles, resolveGraphicsPath } from "./project";

describe("buildIndex", () => {
	test("indexes the fixture's labels, citation keys and inputs", () => {
		const index = buildIndex(fixtureFiles);
		expect([...index.labels.keys()].sort()).toEqual([
			"eq:gain",
			"fig:trace",
			"sec:intro",
			"sec:methods",
			"sec:results",
			"tab:gain",
		]);
		expect([...index.citations.keys()].sort()).toEqual([
			"engbert2003",
			"rolfs2009",
			"rucci2015",
		]);
		expect(index.includes.get("main.tex")).toEqual(["sections/methods.tex"]);
		expect(includedFiles(index, "main.tex")).toEqual([
			"main.tex",
			"sections/methods.tex",
		]);
		expect(includedFiles(index, "supplement.tex")).toEqual(["supplement.tex"]);
	});

	test("label locations point at the command in its file", () => {
		const index = buildIndex(fixtureFiles);
		const methods = fixtureFiles.find((f) => f.path === "sections/methods.tex");
		const [at] = index.labels.get("sec:methods") ?? [];
		expect(at?.path).toBe("sections/methods.tex");
		expect(methods?.text.slice(at?.from, at?.to)).toBe("\\label{sec:methods}");
		const main = fixtureFiles.find((f) => f.path === "main.tex");
		const [eq] = index.labels.get("eq:gain") ?? [];
		expect(main?.text.slice(eq?.from, eq?.to)).toBe("\\label{eq:gain}");
	});

	test("linelabel, bibitem, duplicates, and commented-out labels", () => {
		const index = buildIndex([
			{
				path: "a.tex",
				text: [
					"\\linelabel{ln:one} \\label{dup} % \\label{hidden}",
					"\\verb|\\label{verb}|",
					"\\begin{thebibliography}{9}",
					"\\bibitem[Smith 2020]{smith}",
					"\\bibitem{jones}",
					"\\end{thebibliography}",
				].join("\n"),
			},
			{ path: "b.tex", text: "\\label{dup}" },
		]);
		expect([...index.labels.keys()]).toEqual(["ln:one", "dup"]);
		expect(index.labels.get("dup")?.map((l) => l.path)).toEqual([
			"a.tex",
			"b.tex",
		]);
		expect([...index.citations.keys()]).toEqual(["smith", "jones"]);
	});

	test("include graph resolves like TeX and survives a cycle", () => {
		const index = buildIndex([
			{
				path: "paper/main.tex",
				text: "\\include{chapters/one}\\subfile{chapters/two.tex}\\input{gone}",
			},
			{ path: "paper/chapters/one.tex", text: "\\input{chapters/two}" },
			{ path: "paper/chapters/two.tex", text: "\\input{main}" },
		]);
		expect(includedFiles(index, "paper/main.tex")).toEqual([
			"paper/main.tex",
			"paper/chapters/one.tex",
			"paper/chapters/two.tex",
		]);
	});

	test("graphicspath entries are collected relative to their file", () => {
		const index = buildIndex([
			{ path: "paper/main.tex", text: "\\graphicspath{{figures/}{../img/}}" },
		]);
		expect(index.graphicsPaths).toEqual(["paper/figures", "img"]);
	});
});

describe("resolveGraphicsPath", () => {
	const files = new Set([
		"figures/trace.png",
		"figures/both.png",
		"figures/both.pdf",
		"paper/img/deep.jpg",
		"shared/logo.pdf",
	]);

	test("adds the extension TeX would find first", () => {
		expect(resolveGraphicsPath("figures/trace", "main.tex", files)).toBe(
			"figures/trace.png",
		);
		expect(resolveGraphicsPath("figures/both", "main.tex", files)).toBe(
			"figures/both.pdf",
		);
		expect(resolveGraphicsPath("figures/both.png", "main.tex", files)).toBe(
			"figures/both.png",
		);
	});

	test("searches the including file's directory and its parents", () => {
		expect(resolveGraphicsPath("img/deep", "paper/sections/a.tex", files)).toBe(
			"paper/img/deep.jpg",
		);
		expect(resolveGraphicsPath("../shared/logo", "paper/main.tex", files)).toBe(
			"shared/logo.pdf",
		);
	});

	test("searches graphicspath directories", () => {
		expect(resolveGraphicsPath("trace", "main.tex", files, ["figures"])).toBe(
			"figures/trace.png",
		);
	});

	test("a missing file resolves to nothing", () => {
		expect(resolveGraphicsPath("nope", "main.tex", files)).toBeUndefined();
		expect(resolveGraphicsPath("../../x", "main.tex", files)).toBeUndefined();
	});
});
