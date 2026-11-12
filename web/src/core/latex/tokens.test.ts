import { expect, test } from "vitest";
import { garbage } from "./fixture";
import { sourceTokens } from "./tokens";

test("source tokens colour commands, comments, math, braces and environment names", () => {
	const text =
		"\\section*{A} % note\n$x$ \\begin{itemize}[t] \\% \\[y\\]\\end{itemize}";
	expect(
		sourceTokens(text).map((t) => [t.type, text.slice(t.from, t.to)]),
	).toEqual([
		["command", "\\section*"],
		["brace", "{"],
		["brace", "}"],
		["comment", "% note"],
		["math", "$x$"],
		["command", "\\begin"],
		["brace", "{"],
		["environment", "itemize"],
		["brace", "}"],
		["brace", "["],
		["brace", "]"],
		["command", "\\%"],
		["math", "\\[y\\]"],
		["command", "\\end"],
		["brace", "{"],
		["environment", "itemize"],
		["brace", "}"],
	]);
});

test("source tokens are sorted and disjoint on any input", () => {
	for (let seed = 1; seed <= 200; seed++) {
		const text = garbage(seed, 400);
		let end = 0;
		for (const t of sourceTokens(text)) {
			expect(t.from).toBeGreaterThanOrEqual(end);
			expect(t.to).toBeGreaterThan(t.from);
			end = t.to;
		}
		expect(end).toBeLessThanOrEqual(text.length);
	}
});
