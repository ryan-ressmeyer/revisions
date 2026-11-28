// Which words changed within a hunk's removed and added lines.
import type { DiffLine } from "./diff";

/** `[from, to)` offsets into a line's text. */
export type Range = [number, number];

// A word: a LaTeX command, a run of letters and digits, or any other single
// character that is not a space.
const WORD = /\\[A-Za-z@]+|[\p{L}\p{N}]+|\S/gu;

// ponytail: an O(n·m) table caps the words compared in one block of changes;
// switch to Myers' O(ND) diff if real edits ever hit the cap.
const MAX_CELLS = 2_000_000;

interface Word {
	line: number;
	from: number;
	to: number;
	text: string;
}

/**
 * For each of `lines` (one hunk's), the stretches of text removed or added.
 * Each run of lines other than context is compared as a whole, removed words
 * against added ones. A line that keeps less than half of its words gets no
 * marks, nor does a block too large to compare.
 */
export function changedWords(lines: readonly DiffLine[]): Range[][] {
	const marks: Range[][] = lines.map(() => []);
	let start = 0;
	while (start < lines.length) {
		if (lines[start]?.kind === "context") {
			start++;
			continue;
		}
		let end = start;
		while (end < lines.length && lines[end]?.kind !== "context") end++;
		markBlock(lines, start, end, marks);
		start = end;
	}
	return marks;
}

function words(
	lines: readonly DiffLine[],
	from: number,
	to: number,
	kind: DiffLine["kind"],
): Word[] {
	const out: Word[] = [];
	for (let line = from; line < to; line++) {
		const l = lines[line];
		if (l?.kind !== kind) continue;
		for (const m of l.text.matchAll(WORD)) {
			out.push({ line, from: m.index, to: m.index + m[0].length, text: m[0] });
		}
	}
	return out;
}

function markBlock(
	lines: readonly DiffLine[],
	from: number,
	to: number,
	marks: Range[][],
): void {
	const a = words(lines, from, to, "delete");
	const b = words(lines, from, to, "add");
	const keptA = new Array<boolean>(a.length).fill(false);
	const keptB = new Array<boolean>(b.length).fill(false);

	// The common start and end need no table.
	let lo = 0;
	while (lo < a.length && lo < b.length && a[lo]?.text === b[lo]?.text) {
		keptA[lo] = keptB[lo] = true;
		lo++;
	}
	let hiA = a.length;
	let hiB = b.length;
	while (hiA > lo && hiB > lo && a[hiA - 1]?.text === b[hiB - 1]?.text) {
		keptA[--hiA] = keptB[--hiB] = true;
	}

	const n = hiA - lo;
	const m = hiB - lo;
	if (n > 0 && m > 0) {
		if ((n + 1) * (m + 1) > MAX_CELLS) return;
		// lcs[i * (m + 1) + j]: the longest common run of a[lo+i..] and b[lo+j..].
		const w = m + 1;
		const lcs = new Uint32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				lcs[i * w + j] =
					a[lo + i]?.text === b[lo + j]?.text
						? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
						: Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (a[lo + i]?.text === b[lo + j]?.text) {
				keptA[lo + i++] = keptB[lo + j++] = true;
			} else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) i++;
			else j++;
		}
	}

	mark(a, keptA, marks);
	mark(b, keptB, marks);
}

/** Marks each line's unkept words, joining neighbours into one stretch. */
function mark(ws: Word[], kept: boolean[], marks: Range[][]): void {
	let i = 0;
	while (i < ws.length) {
		const line = ws[i]?.line ?? 0;
		let end = i;
		let keeps = 0;
		while (end < ws.length && ws[end]?.line === line) if (kept[end++]) keeps++;
		if (keeps * 2 >= end - i) {
			const ranges = marks[line] ?? [];
			for (let k = i; k < end; k++) {
				const word = ws[k];
				if (!word || kept[k]) continue;
				const last = ranges.at(-1);
				if (last && k > i && !kept[k - 1]) last[1] = word.to;
				else ranges.push([word.from, word.to]);
			}
		}
		i = end;
	}
}
