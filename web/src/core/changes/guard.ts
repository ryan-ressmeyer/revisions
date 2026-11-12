// Keeping `changes` macros whole while their markup is hidden in Rich mode.
import { findChanges } from "../latex/changes";
import type { Range } from "../latex/scan";
import type { Edit } from "./changes";

/** What to apply instead of an edit, from {@link guardEdit}. */
export interface GuardedEdit {
	/** Sorted, non-overlapping edits against the text before the edit; may be empty. */
	edits: Edit[];
	/** Where to put the (empty) selection, as an offset into the text after `edits`. */
	cursor: number;
}

/**
 * What Rich mode hides of every complete `changes` macro. With `markup`
 * shown that is everything but the text arguments, such as
 * `\added[id=X]{`, `}{` and `}`. With it hidden (a clean reading view), a
 * `\deleted` or `\comment` is hidden whole, and so is the old text of a
 * `\replaced`; see `buildPlan`'s `markup` option.
 */
export function changeMarkup(text: string, markup = true): Range[] {
	const out: Range[] = [];
	for (const c of findChanges(text)) {
		if (!markup && (c.kind === "deleted" || c.kind === "comment")) {
			out.push({ from: c.from, to: c.to });
			continue;
		}
		out.push({ from: c.from, to: c.text.from });
		if (c.old && markup) {
			out.push({ from: c.text.to, to: c.old.from });
			out.push({ from: c.old.to, to: c.to });
		} else {
			out.push({ from: c.text.to, to: c.to });
		}
	}
	return out.sort((a, b) => a.from - b.from);
}

/**
 * A plain edit made where the markup of `changes` macros is hidden, adjusted
 * so that it never removes part of a macro's markup without the whole macro.
 * `undefined` when the edit is safe as it is.
 *
 * - A deletion that cuts through a macro removes only the visible text it
 *   covers; the markup stays, and any inserted text goes where the first
 *   removed piece was.
 * - A deletion of nothing but markup (Backspace or Delete next to hidden
 *   markup) deletes the one character beyond the markup instead, in the
 *   direction of the key (`forward` for Delete). When that character is a
 *   brace or a backslash, or there is none, nothing is deleted and the
 *   cursor moves past the markup.
 * - Typing over nothing but markup is refused.
 *
 * `markup` false guards what {@link changeMarkup} hides in the clean reading
 * view, deleted text included, the same way.
 */
export function guardEdit(
	text: string,
	edit: Edit,
	forward = false,
	markup = true,
): GuardedEdit | undefined {
	const { from, to, insert } = edit;
	if (from === to) return undefined;
	const all = changeMarkup(text, markup);
	// Nothing visible goes, such as an atomic hidden range deleted whole by
	// Backspace: act as if the key was pressed beside it.
	if (!insert && covered(all, from, to)) {
		return forward
			? deleteAfter(text, to, from, all)
			: deleteBefore(text, from, all);
	}
	// Markup of macros the edit removes whole may go with them.
	const whole = findChanges(text).filter((c) => from <= c.from && c.to <= to);
	const hit = all.filter(
		(m) =>
			m.from < to &&
			m.to > from &&
			!whole.some((c) => c.from <= m.from && m.to <= c.to),
	);
	if (hit.length === 0) return undefined;

	const pieces: Range[] = [];
	let at = from;
	for (const m of hit) {
		if (m.from > at) pieces.push({ from: at, to: m.from });
		at = Math.max(at, m.to);
	}
	if (at < to) pieces.push({ from: at, to });
	const first = pieces[0];
	if (first) {
		return {
			edits: pieces.map((p, i) => ({ ...p, insert: i === 0 ? insert : "" })),
			cursor: first.from + insert.length,
		};
	}
	if (insert) return { edits: [], cursor: from };
	return forward
		? deleteAfter(text, to, from, all)
		: deleteBefore(text, from, all);
}

const stops = new Set(["{", "}", "\\"]);

// Whether `ranges` cover every character of `from`–`to`.
function covered(ranges: Range[], from: number, to: number): boolean {
	let at = from;
	for (const r of ranges) {
		if (r.from > at) break;
		at = Math.max(at, r.to);
	}
	return at >= to;
}

function deleteBefore(text: string, pos: number, markup: Range[]): GuardedEdit {
	for (;;) {
		const m = markup.find((r) => r.from < pos && pos <= r.to);
		if (!m) break;
		pos = m.from;
	}
	const ch = text[pos - 1];
	if (ch === undefined || stops.has(ch)) return { edits: [], cursor: pos };
	const size = isLowSurrogate(text, pos - 1) ? 2 : 1;
	return {
		edits: [{ from: pos - size, to: pos, insert: "" }],
		cursor: pos - size,
	};
}

function deleteAfter(
	text: string,
	pos: number,
	cursor: number,
	markup: Range[],
): GuardedEdit {
	for (;;) {
		const m = markup.find((r) => r.from <= pos && pos < r.to);
		if (!m) break;
		pos = m.to;
	}
	const ch = text[pos];
	if (ch === undefined || stops.has(ch)) return { edits: [], cursor: pos };
	const size = isLowSurrogate(text, pos + 1) ? 2 : 1;
	return { edits: [{ from: pos, to: pos + size, insert: "" }], cursor };
}

function isLowSurrogate(text: string, i: number): boolean {
	const c = text.charCodeAt(i);
	return c >= 0xdc00 && c <= 0xdfff;
}
