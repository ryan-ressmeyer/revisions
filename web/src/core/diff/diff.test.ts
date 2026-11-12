import { expect, test } from "vitest";
import { type DiffFile, parseDiff } from "./diff";

// Real `git diff` output for one commit's worth of changes.
const SAMPLE = String.raw`diff --git "a/caf\303\251.tex" "b/caf\303\251.tex"
index 587be6b..975fbec 100644
--- "a/caf\303\251.tex"
+++ "b/caf\303\251.tex"
@@ -1 +1 @@
-x
+y
diff --git a/dashes.tex b/dashes.tex
index f2c1329..2fa992c 100644
--- a/dashes.tex
+++ b/dashes.tex
@@ -1,3 +1 @@
--- dash
-++ plus
 keep
diff --git a/fig.png b/fig.png
index 8352675..1592e5c 100644
Binary files a/fig.png and b/fig.png differ
diff --git a/gone.tex b/gone.tex
deleted file mode 100644
index 286c5f5..0000000
--- a/gone.tex
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/main.tex b/main.tex
index 0a2827b..a79750e 100644
--- a/main.tex
+++ b/main.tex
@@ -1,5 +1,5 @@
 \documentclass{article}
-\title{Old}
+\title{New}
 \begin{document}
 Hello
-\end{document}
\ No newline at end of file
+\end{document}
diff --git a/old name.tex b/new name.tex
similarity index 100%
rename from old name.tex
rename to new name.tex
diff --git a/new.tex b/new.tex
new file mode 100644
index 0000000..92d5444
--- /dev/null
+++ b/new.tex
@@ -0,0 +1 @@
+fresh
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

/** The number of input lines a parse result accounts for. */
function linesKept(files: DiffFile[]): number {
	return files
		.flatMap((file) => [
			file.header.length,
			...file.hunks.map((hunk) => 1 + hunk.lines.length),
		])
		.reduce((sum, n) => sum + n, 0);
}

test("lists every file of a diff with its paths, status, and binary flag", () => {
	const files = parseDiff(SAMPLE);
	expect(
		files.map((f) => [
			f.oldPath,
			f.newPath,
			f.status,
			f.binary,
			f.hunks.length,
		]),
	).toEqual([
		["café.tex", "café.tex", "modified", false, 1],
		["dashes.tex", "dashes.tex", "modified", false, 1],
		["fig.png", "fig.png", "modified", true, 0],
		["gone.tex", null, "deleted", false, 1],
		["main.tex", "main.tex", "modified", false, 1],
		["old name.tex", "new name.tex", "renamed", false, 0],
		[null, "new.tex", "added", false, 1],
		["run.sh", "run.sh", "modified", false, 0],
	]);
	expect(linesKept(files)).toBe(SAMPLE.split("\n").length - 1);
});

test("numbers the lines of a hunk and keeps the no-newline marker as meta", () => {
	const main = parseDiff(SAMPLE).find((file) => file.newPath === "main.tex");
	expect(main?.hunks).toEqual([
		{
			header: "@@ -1,5 +1,5 @@",
			lines: [
				{
					kind: "context",
					text: "\\documentclass{article}",
					oldLine: 1,
					newLine: 1,
				},
				{ kind: "delete", text: "\\title{Old}", oldLine: 2, newLine: null },
				{ kind: "add", text: "\\title{New}", oldLine: null, newLine: 2 },
				{ kind: "context", text: "\\begin{document}", oldLine: 3, newLine: 3 },
				{ kind: "context", text: "Hello", oldLine: 4, newLine: 4 },
				{ kind: "delete", text: "\\end{document}", oldLine: 5, newLine: null },
				{
					kind: "meta",
					text: "\\ No newline at end of file",
					oldLine: null,
					newLine: null,
				},
				{ kind: "add", text: "\\end{document}", oldLine: null, newLine: 5 },
			],
		},
	]);
});

test("a deleted line that looks like a file header stays a deleted line", () => {
	const dashes = parseDiff(SAMPLE).find((f) => f.newPath === "dashes.tex");
	expect(dashes?.hunks[0]?.lines.map((l) => [l.kind, l.text])).toEqual([
		["delete", "-- dash"],
		["delete", "++ plus"],
		["context", "keep"],
	]);
});

test("each hunk starts at the line numbers its header gives", () => {
	const [file] = parseDiff(
		[
			"diff --git a/a.tex b/a.tex",
			"--- a/a.tex",
			"+++ b/a.tex",
			"@@ -3 +3,2 @@",
			" three",
			"+three and a half",
			"@@ -40,2 +41,2 @@ \\section{Methods}",
			"-forty",
			"+forty!",
			" forty-one",
			"",
		].join("\n"),
	);
	expect(file?.hunks.map((hunk) => hunk.header)).toEqual([
		"@@ -3 +3,2 @@",
		"@@ -40,2 +41,2 @@ \\section{Methods}",
	]);
	expect(
		file?.hunks.map((h) => h.lines.map((l) => [l.oldLine, l.newLine])),
	).toEqual([
		[
			[3, 3],
			[null, 4],
		],
		[
			[40, null],
			[null, 41],
			[41, 42],
		],
	]);
});

test("reads plain unified diffs that have no `diff` line", () => {
	const files = parseDiff(
		[
			"--- a/one.tex\t2026-11-10 09:00:00",
			"+++ b/one.tex\t2026-11-10 09:01:00",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"--- /dev/null",
			"+++ b/two words.tex\t",
			"@@ -0,0 +1 @@",
			"+c",
		].join("\n"),
	);
	expect(files.map((f) => [f.oldPath, f.newPath, f.status])).toEqual([
		["one.tex", "one.tex", "modified"],
		[null, "two words.tex", "added"],
	]);
	expect(files[1]?.hunks[0]?.lines).toEqual([
		{ kind: "add", text: "c", oldLine: null, newLine: 1 },
	]);
});

test("never throws and drops nothing on text that is not a diff", () => {
	expect(parseDiff("")).toEqual([]);

	const junk = [
		"commit 1234",
		"@@ nonsense @@",
		"diff --git",
		"@@ -1,2 +1,2 @@",
		" kept",
		"what is this",
		"",
		"+++ only half a header",
		"@@ -0,0 +0,0 @@",
		'--- "a/not utf-8 \\377"',
		"+++ b/x",
	].join("\n");
	const files = parseDiff(junk);
	expect(linesKept(files)).toBe(junk.split("\n").length);
	expect(files[1]?.hunks[0]?.lines.map((line) => line.kind)).toEqual([
		"context",
		"meta",
		"context",
		"add",
	]);
	expect(files[2]).toMatchObject({
		oldPath: '"a/not utf-8 \\377"',
		newPath: "x",
	});
});
