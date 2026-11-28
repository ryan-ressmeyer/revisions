import { expect, test } from "vitest";
import type { DiffLine } from "./diff";
import { changedWords } from "./words";

const ctx = (text: string): DiffLine => ({
	kind: "context",
	text,
	oldLine: 1,
	newLine: 1,
});
const del = (text: string): DiffLine => ({
	kind: "delete",
	text,
	oldLine: 1,
	newLine: null,
});
const add = (text: string): DiffLine => ({
	kind: "add",
	text,
	oldLine: null,
	newLine: 1,
});
const meta = (text: string): DiffLine => ({
	kind: "meta",
	text,
	oldLine: null,
	newLine: null,
});

/** The marked text of each line, for readable expectations. */
function marked(lines: DiffLine[]): string[][] {
	return changedWords(lines).map((ranges, i) =>
		ranges.map(([from, to]) => lines[i]?.text.slice(from, to) ?? ""),
	);
}

test("a one-word edit marks only the old word and the new one", () => {
	expect(
		marked([
			ctx("\\section{Results}"),
			del("The results suggest that attention modulates gain in V1."),
			add("The results indicate that attention modulates gain in V1."),
			ctx(""),
		]),
	).toEqual([[], ["suggest"], ["indicate"], []]);
});

test("neighbouring changed words are marked as one stretch", () => {
	expect(
		marked([
			del("Attention clearly modulates gain."),
			add("Attention may weakly modulate gain."),
		]),
	).toEqual([["clearly modulates"], ["may weakly modulate"]]);
});

test("a paragraph split in two marks nothing", () => {
	expect(
		marked([
			del("First sentence here. Second sentence there."),
			add("First sentence here."),
			add("Second sentence there."),
		]),
	).toEqual([[], [], []]);
});

test("a new paragraph before an edited one leaves the new one unmarked", () => {
	expect(
		marked([
			del("We recorded from twelve neurons in total."),
			add("A brand new paragraph about the methods."),
			add("We recorded from thirteen neurons in total."),
		]),
	).toEqual([["twelve"], [], ["thirteen"]]);
});

test("a rewritten paragraph is not marked", () => {
	expect(
		marked([del("The cat sat on the mat."), add("A dog ran across the yard.")]),
	).toEqual([[], []]);
});

test("a LaTeX command is a word of its own", () => {
	expect(
		marked([
			del("Gain \\emph{rises} with contrast."),
			add("Gain \\textit{rises} with contrast."),
		]),
	).toEqual([["\\emph"], ["\\textit"]]);
});

test("a missing final newline does not split the change", () => {
	expect(
		marked([
			del("The last line of the file"),
			meta("\\ No newline at end of file"),
			add("The last lines of the file"),
			meta("\\ No newline at end of file"),
		]),
	).toEqual([["line"], [], ["lines"], []]);
});

test("a very large block of changes is not marked", () => {
	const words = (tag: string) =>
		Array.from({ length: 3000 }, (_, i) => `${tag}${i}`).join(" ");
	const lines = [
		del(`start ${words("a")} end`),
		add(`start ${words("b")} end`),
	];
	expect(changedWords(lines)).toEqual([[], []]);
});
