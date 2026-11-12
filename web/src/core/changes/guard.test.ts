import { describe, expect, test } from "vitest";
import { applyEdits, type Edit } from "./changes";
import { guardEdit } from "./guard";

const del = (from: number, to: number): Edit => ({ from, to, insert: "" });

/** The text after the guarded edit, and the cursor in it. */
function guarded(text: string, edit: Edit, forward = false) {
	const g = guardEdit(text, edit, forward);
	if (!g) return undefined;
	return { text: applyEdits(text, g.edits), cursor: g.cursor };
}

describe("guardEdit", () => {
	const text = "ab \\added[id=X]{cd} ef";
	const head = text.indexOf("cd");
	const tail = head + 2;

	test("edits that leave every macro whole pass unchanged", () => {
		expect(guardEdit(text, del(0, 1))).toBeUndefined();
		expect(guardEdit(text, del(head, head + 1))).toBeUndefined();
		expect(guardEdit(text, { from: tail, to: tail, insert: "x" })).toBe(
			undefined,
		);
		expect(guardEdit(text, del(2, tail + 2))).toBeUndefined();
		expect(guardEdit(text, del(0, text.length))).toBeUndefined();
	});

	test("Backspace over hidden markup deletes the character before the macro", () => {
		expect(guarded(text, del(3, head))).toEqual({
			text: "ab\\added[id=X]{cd} ef",
			cursor: 2,
		});
	});

	test("Delete over hidden markup deletes the character after the macro", () => {
		expect(guarded(text, del(tail, tail + 1), true)).toEqual({
			text: "ab \\added[id=X]{cd}ef",
			cursor: tail,
		});
	});

	test("a selection cutting through a macro keeps its markup and loses the visible text", () => {
		expect(guarded(text, { from: 1, to: head + 1, insert: "Z" })).toEqual({
			text: "aZ\\added[id=X]{d} ef",
			cursor: 2,
		});
		const replaced = "\\replaced[id=X]{new}{old}.";
		const from = replaced.indexOf("w");
		const to = replaced.lastIndexOf("l");
		expect(guarded(replaced, del(from, to))).toEqual({
			text: "\\replaced[id=X]{ne}{ld}.",
			cursor: from,
		});
	});

	test("Backspace skips the markup of neighbouring macros", () => {
		const two = "\\added[id=X]{a}\\added[id=X]{b}";
		const second = two.lastIndexOf("\\added");
		expect(guarded(two, del(second, two.lastIndexOf("b")))).toEqual({
			text: "\\added[id=X]{}\\added[id=X]{b}",
			cursor: two.indexOf("{a}") + 1,
		});
	});

	test("braces, a backslash or the start of the text stop the redirect", () => {
		const styled = "\\emph{x}\\added[id=X]{cd}";
		const from = styled.indexOf("\\added");
		expect(guarded(styled, del(from, styled.indexOf("cd")))).toEqual({
			text: styled,
			cursor: from,
		});
		const first = "\\added[id=X]{cd}";
		expect(guarded(first, del(0, first.indexOf("cd")))).toEqual({
			text: first,
			cursor: 0,
		});
		expect(guarded(first, del(first.length - 1, first.length), true)).toEqual({
			text: first,
			cursor: first.length,
		});
	});

	test("a character outside the basic plane is deleted whole", () => {
		const emoji = "x😀\\deleted[id=X]{y}";
		const from = emoji.indexOf("\\");
		expect(guarded(emoji, del(from, emoji.indexOf("y")))).toEqual({
			text: "x\\deleted[id=X]{y}",
			cursor: 1,
		});
	});

	test("typing over nothing but markup is refused", () => {
		expect(guarded(text, { from: 3, to: head, insert: "Q" })).toEqual({
			text,
			cursor: 3,
		});
	});
});

describe("guardEdit with markup hidden", () => {
	const text = "ab \\deleted[id=X]{gone} cd \\replaced[id=X]{new}{old} ef";
	const gone = text.indexOf("\\deleted");
	const goneEnd = text.indexOf(" cd");
	const oldEnd = text.indexOf(" ef");
	const hidden = (edit: Edit, forward = false) => {
		const g = guardEdit(text, edit, forward, false);
		return g && { text: applyEdits(text, g.edits), cursor: g.cursor };
	};

	test("Backspace after hidden deleted text deletes the character before it", () => {
		// CodeMirror deletes an atomic range whole.
		expect(hidden(del(gone, goneEnd))).toEqual({
			text: text.replace("ab ", "ab"),
			cursor: gone - 1,
		});
		expect(hidden(del(goneEnd - 1, goneEnd))).toEqual({
			text: text.replace("ab ", "ab"),
			cursor: gone - 1,
		});
	});

	test("Delete before hidden deleted text deletes the character after it", () => {
		expect(hidden(del(gone, goneEnd), true)).toEqual({
			text: text.replace("} cd", "}cd"),
			cursor: gone,
		});
	});

	test("Backspace after a replacement's hidden old text deletes the new text's last character", () => {
		expect(hidden(del(oldEnd - 1, oldEnd))?.text).toBe(
			text.replace("{new}", "{ne}"),
		);
	});

	test("typing over hidden text alone is refused, and visible text around it can go", () => {
		expect(hidden({ from: gone + 2, to: goneEnd - 1, insert: "x" })).toEqual({
			text,
			cursor: gone + 2,
		});
		expect(guardEdit(text, del(0, 2), false, false)).toBeUndefined();
	});
});
