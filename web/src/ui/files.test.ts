import { expect, test } from "vitest";
import { decodeFile } from "./files";

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

test("decodes UTF-8 with every line break as \\n and no byte-order mark", () => {
	const text = "﻿a\r\nb\rc\nd";
	expect(decodeFile(new TextEncoder().encode(text).buffer, "h")).toEqual({
		text: "a\nb\nc\nd",
		hash: "h",
		readOnly: false,
	});
});

test("a file that is not valid UTF-8 opens read-only", () => {
	const file = decodeFile(bytes(0x61, 0xff, 0x62), "h");
	expect(file.readOnly).toBe(true);
	expect(file.text).toBe("a�b");
});
