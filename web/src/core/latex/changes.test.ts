import { expect, test } from "vitest";
import { findChanges } from "./changes";
import { fixture } from "./fixture";

function slices(text: string) {
	return findChanges(text).map((c) => ({
		kind: c.kind,
		whole: text.slice(c.from, c.to),
		author: c.author,
		comment: c.comment,
		options: c.options && text.slice(c.options.from, c.options.to),
		text: text.slice(c.text.from, c.text.to),
		old: c.old && text.slice(c.old.from, c.old.to),
	}));
}

test("each changes macro is found with its arguments", () => {
	const text = [
		"a \\added[id=RR]{new} b",
		"\\deleted[id=RR]{gone}",
		"\\replaced[id=AB, comment=short]{fresh}{stale}",
		"\\highlight{plain}",
		"\\comment[id=RR]{a note}",
	].join("\n");
	expect(slices(text)).toEqual([
		{
			kind: "added",
			whole: "\\added[id=RR]{new}",
			author: "RR",
			comment: undefined,
			options: "[id=RR]",
			text: "new",
			old: undefined,
		},
		{
			kind: "deleted",
			whole: "\\deleted[id=RR]{gone}",
			author: "RR",
			comment: undefined,
			options: "[id=RR]",
			text: "gone",
			old: undefined,
		},
		{
			kind: "replaced",
			whole: "\\replaced[id=AB, comment=short]{fresh}{stale}",
			author: "AB",
			comment: "short",
			options: "[id=AB, comment=short]",
			text: "fresh",
			old: "stale",
		},
		{
			kind: "highlight",
			whole: "\\highlight{plain}",
			author: undefined,
			comment: undefined,
			options: undefined,
			text: "plain",
			old: undefined,
		},
		{
			kind: "comment",
			whole: "\\comment[id=RR]{a note}",
			author: "RR",
			comment: undefined,
			options: "[id=RR]",
			text: "a note",
			old: undefined,
		},
	]);
});

test("a braced comment keeps its commas, brackets and braces", () => {
	const text =
		"\\highlight[id=RR, comment={text with, commas [1] and {braces}}]{target}";
	expect(slices(text)).toMatchObject([
		{
			author: "RR",
			comment: "text with, commas [1] and {braces}",
			text: "target",
		},
	]);
});

test("nested changes are listed in source order", () => {
	const text = "\\highlight[comment={c}]{a \\added{b} \\textbf{\\deleted{d}}}";
	expect(slices(text).map((c) => [c.kind, c.text])).toEqual([
		["highlight", "a \\added{b} \\textbf{\\deleted{d}}"],
		["added", "b"],
		["deleted", "d"],
	]);
});

test("half-typed, commented and verbatim macros are not changes", () => {
	const text = [
		"\\added[id=x] no argument",
		"% \\added{commented}",
		"\\verb|\\added{verb}|",
		"\\replaced{only one}",
		"\\deleted{unclosed",
	].join("\n");
	expect(findChanges(text)).toEqual([]);
});

test("the fixture has no changes markup", () => {
	expect(findChanges(fixture("main.tex"))).toEqual([]);
});
