import { expect, test } from "vitest";
import { findChanges } from "../latex/changes";
import { fixture } from "../latex/fixture";
import { acceptAll, applyEdits, type Edit, rejectAll } from "./changes";
import { trackEdit } from "./track";

const main = fixture("main.tex");

function at(text: string, needle: string): number {
	const i = text.indexOf(needle);
	if (i < 0) throw new Error(`no ${needle}`);
	return i;
}

// The text after applying `edit` with tracking, and where the cursor went.
function track(text: string, edit: Edit, forward = false) {
	const r = trackEdit(text, edit, "RR", forward);
	return { ...r, out: applyEdits(text, r.edits) };
}

// Tracked keystrokes from `cursor`; each must be tracked.
function keys(
	text: string,
	cursor: number,
	strokes: ("backspace" | "delete" | string)[],
) {
	for (const key of strokes) {
		const edit =
			key === "backspace"
				? { from: cursor - 1, to: cursor, insert: "" }
				: key === "delete"
					? { from: cursor, to: cursor + 1, insert: "" }
					: { from: cursor, to: cursor, insert: key };
		const r = track(text, edit, key === "delete");
		expect(r.tracked, `${key} at ${cursor}`).toBe(true);
		text = r.out;
		cursor = r.cursor;
	}
	return { text, cursor };
}

function expectInvariants(original: string, tracked: string, plain: string) {
	expect(applyEdits(tracked, rejectAll(tracked))).toBe(original);
	expect(applyEdits(tracked, acceptAll(tracked))).toBe(plain);
}

test("Tracked edit: replacing a word records a \\replaced with the author ID", () => {
	const from = at(main, "never still");
	const r = track(main, { from, to: from + 5, insert: "rarely" });
	expect(r.tracked).toBe(true);
	expect(r.out).toContain(
		"The eyes are \\replaced[id=RR]{rarely}{never} still.",
	);
	expect(r.cursor).toBe(at(r.out, "rarely") + "rarely".length);
});

test("typing a word one key at a time gives one \\added that holds it", () => {
	const p = at(main, "still.") + "still.".length;
	const { text, cursor } = keys(main, p, [..." Truly"]);
	expect(text).toContain("still.\\added[id=RR]{ Truly}");
	expect(findChanges(text)).toHaveLength(1);
	expect(cursor).toBe(at(text, " Truly}") + " Truly".length);
	expectInvariants(main, text, `${main.slice(0, p)} Truly${main.slice(p)}`);
});

test("Backspace and Delete over a word give one \\deleted, with the cursor outside it", () => {
	const p = at(main, "never still");
	const plain = main.slice(0, p) + main.slice(p + 5);
	const back = keys(main, p + 5, Array(5).fill("backspace"));
	expect(back.text).toContain("are \\deleted[id=RR]{never} still");
	expect(back.cursor).toBe(p);
	expectInvariants(main, back.text, plain);
	const fwd = keys(main, p, Array(5).fill("delete"));
	expect(fwd.text).toBe(back.text);
	expect(fwd.cursor).toBe(p + "\\deleted[id=RR]{never}".length);
});

test("deleting typed text removes it, and deleting all of it removes the \\added", () => {
	const p = at(main, " still.");
	const typed = keys(main, p, [..."abc", "backspace"]);
	expect(typed.text).toContain("never\\added[id=RR]{ab} still.");
	expect(keys(typed.text, typed.cursor, ["backspace", "backspace"])).toEqual({
		text: main,
		cursor: p,
	});
});

test("typing goes on after a replacement, and deleting all new text leaves a \\deleted", () => {
	const from = at(main, "never still");
	const r = track(main, { from, to: from + 5, insert: "r" });
	const typed = keys(r.out, r.cursor, [..."arely"]);
	expect(typed.text).toContain("are \\replaced[id=RR]{rarely}{never} still");
	expectInvariants(
		main,
		typed.text,
		`${main.slice(0, from)}rarely${main.slice(from + 5)}`,
	);
	const gone = keys(typed.text, typed.cursor, Array(6).fill("backspace"));
	expect(gone.text).toContain("are \\deleted[id=RR]{never} still");
	expect(gone.cursor).toBe(from);
});

test("deleting inside an existing \\deleted only moves the cursor", () => {
	const text = "\\begin{document}\nA \\deleted[id=AB]{gone} b\n\\end{document}";
	const macro = { from: at(text, "\\deleted"), to: at(text, " b\n") };
	const inside = at(text, "one");
	expect(track(text, { from: inside, to: inside + 1, insert: "" })).toEqual({
		edits: [],
		cursor: macro.from,
		tracked: true,
		out: text,
	});
	expect(
		track(text, { from: macro.to - 1, to: macro.to, insert: "" }, true).cursor,
	).toBe(macro.to);
});

test("edits that cannot be tracked safely are applied plainly, with tracked false", () => {
	const text = [
		"\\documentclass{article}",
		"\\begin{document}",
		"Words \\emph{em} and $x$ here \\highlight[id=AB, comment={note}]{marked} and \\added[id=AB]{theirs} end.",
		"",
		"Next \\begin{itemize}",
		"\\item one",
		"\\end{itemize}",
		"\\end{document}",
	].join("\n");
	const plain: Edit[] = [
		{ from: at(text, "article"), to: at(text, "article"), insert: "x" },
		{ from: at(text, "note"), to: at(text, "note"), insert: "x" },
		{ from: at(text, "\\emph"), to: at(text, "em}"), insert: "" },
		{ from: at(text, "x$"), to: at(text, "x$"), insert: "y" },
		{ from: at(text, "end."), to: at(text, "Next"), insert: "" },
		{ from: at(text, "one"), to: at(text, "\\end{itemize}") + 3, insert: "" },
		{ from: at(text, "and \\added"), to: at(text, "eirs}"), insert: "" },
		{ from: at(text, "here"), to: at(text, "here"), insert: "\n\n" },
		{ from: at(text, "here"), to: at(text, "here"), insert: "{" },
		{ from: at(text, "\\item"), to: at(text, "\\item"), insert: "x" },
	];
	for (const edit of plain) {
		expect(trackEdit(text, edit, "RR"), JSON.stringify(edit)).toEqual({
			edits: [edit],
			cursor: edit.from + edit.insert.length,
			tracked: false,
		});
	}
});

// Deterministic pseudo-random integers in [0, n).
function rng(seed: number) {
	let state = seed;
	return (n: number) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state % n;
	};
}

const bodyFrom = at(main, "\\begin{document}") + "\\begin{document}".length;
const bodyTo = at(main, "\\end{document}");

test("any tracked edit to the fixture rejects back to the original and accepts to the plain edit", () => {
	const pick = rng(1);
	const inserts = ["", "x", "word", " and ", "\\emph{new}", "$z$", "\n"];
	let tracked = 0;
	const n = 3000;
	for (let i = 0; i < n; i++) {
		const from = bodyFrom + pick(bodyTo - bodyFrom);
		const to = Math.min(from + pick(4) * pick(6), bodyTo);
		const insert = inserts[pick(inserts.length)] ?? "";
		if (from === to && !insert) continue;
		const edit = { from, to, insert };
		const r = track(main, edit);
		const plain = applyEdits(main, [edit]);
		expect(r.cursor).toBeGreaterThanOrEqual(0);
		expect(r.cursor).toBeLessThanOrEqual(r.out.length);
		if (!r.tracked) {
			expect(r.out).toBe(plain);
			continue;
		}
		tracked++;
		expectInvariants(main, r.out, plain);
	}
	expect(tracked).toBeGreaterThan(n / 3);
});

test("random typing and deleting runs each give one macro and keep the invariants", () => {
	const pick = rng(2);
	let runs = 0;
	for (let i = 0; i < 400; i++) {
		const p = bodyFrom + pick(bodyTo - bodyFrom);
		const k = 1 + pick(8);
		const kind = pick(3);
		const strokes =
			kind === 0
				? [..."new words".slice(0, k)]
				: Array(k).fill(kind === 1 ? "backspace" : "delete");
		const plain =
			kind === 0
				? main.slice(0, p) + "new words".slice(0, k) + main.slice(p)
				: kind === 1
					? main.slice(0, p - k) + main.slice(p)
					: main.slice(0, p) + main.slice(p + k);
		let text = main;
		let cursor = p;
		let ok = true;
		for (const key of strokes) {
			const edit =
				key === "backspace"
					? { from: cursor - 1, to: cursor, insert: "" }
					: key === "delete"
						? { from: cursor, to: cursor + 1, insert: "" }
						: { from: cursor, to: cursor, insert: key };
			const r = track(text, edit, key === "delete");
			if (!r.tracked) {
				ok = false;
				break;
			}
			text = r.out;
			cursor = r.cursor;
		}
		if (!ok) continue;
		runs++;
		expect(findChanges(text)).toHaveLength(1);
		expectInvariants(main, text, plain);
	}
	expect(runs).toBeGreaterThan(100);
});
