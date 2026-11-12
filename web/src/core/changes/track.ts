// Tracked editing: what to apply instead of a user's edit while "Track
// changes" is on.
import { type Change, findChanges } from "../latex/changes";
import { applyEdits, type Edit, whyNotWrap } from "./changes";

/** What to apply instead of a user's edit, from {@link trackEdit}. */
export interface TrackedEdit {
	/** Sorted, non-overlapping edits against the text before the edit. */
	edits: Edit[];
	/**
	 * Where to put the (empty) selection, as an offset into the text after
	 * `edits` are applied.
	 */
	cursor: number;
	/**
	 * False when the edit could not be tracked safely and `edits` is the plain
	 * edit unchanged; the editor should tell the user it went in untracked.
	 */
	tracked: boolean;
}

/**
 * Maps one user edit (`from`–`to` replaced by `insert`) to the edits that
 * record it as a tracked change by `authorId`.
 *
 * - Typing inserts `\added[id=<authorId>]{…}`, with the cursor inside it,
 *   at the end. Typing within (or right after) the author's own `\added`, or
 *   within the new text of their own `\replaced`, edits that text in place;
 *   emptying an own `\added` removes it, and emptying the new text of an own
 *   `\replaced` turns it into a `\deleted` of the old text.
 * - Deleting wraps the text in `\deleted[id=<authorId>]{…}`, or grows the
 *   author's own `\deleted` when it touches it. The cursor goes before the
 *   macro, or after it when `forward` is true (the Delete key rather than
 *   Backspace). Deleting within a `\deleted` (anyone's, markup included), or
 *   within the old text of a `\replaced`, changes nothing and only moves the
 *   cursor out of it.
 * - Replacing a selection gives `\replaced[id=<authorId>]{new}{old}` with
 *   the cursor at the end of the new text.
 *
 * Edits that cannot be wrapped so that the file still compiles come back as
 * the plain edit with `tracked: false`: see `whyNotWrap` for the rules
 * (preamble, math, comment options, cut markup, paragraph breaks,
 * environments, ranges that contain other changes), plus edits whose
 * inserted text would unbalance the macro or add a paragraph break.
 */
export function trackEdit(
	text: string,
	edit: Edit,
	authorId: string,
	forward = false,
): TrackedEdit {
	// ponytail: anything not covered above (a range spanning the author's own
	// \added and other text, typing LaTeX markup one key at a time, edits in
	// comment text) goes in untracked. Split such an edit into trackable
	// pieces if users run into it.
	return (
		track(text, edit, authorId, forward) ?? {
			edits: [edit],
			cursor: edit.from + edit.insert.length,
			tracked: false,
		}
	);
}

function track(
	text: string,
	edit: Edit,
	me: string,
	forward: boolean,
): TrackedEdit | undefined {
	const { from, to, insert } = edit;
	if (from === to && !insert) return { edits: [], cursor: from, tracked: true };
	const changes = findChanges(text);
	// The innermost change whose new or marked text holds the whole edit.
	const host = changes.findLast((c) => c.text.from <= from && to <= c.text.to);
	if (
		host?.author === me &&
		(host.kind === "added" || host.kind === "replaced")
	) {
		return inOwn(text, host, edit, me, forward);
	}
	if (!insert) {
		const done = changes.findLast(
			(c) =>
				(c.kind === "deleted" && c.from <= from && to <= c.to) ||
				(c.kind === "replaced" &&
					c.old !== undefined &&
					c.old.from - 1 <= from &&
					to <= c.to),
		);
		if (done) {
			const cursor = forward
				? done.to
				: done.kind === "deleted"
					? done.from
					: done.text.to;
			return { edits: [], cursor, tracked: true };
		}
		return remove(text, changes, edit, me, forward);
	}
	if (from === to) {
		const prev = changes.find(
			(c) => c.kind === "added" && c.author === me && c.to === from,
		);
		if (prev) {
			const at = prev.text.to;
			return inOwn(text, prev, { from: at, to: at, insert }, me, forward);
		}
	}
	if (whyNotWrap(text, edit, "track")) return undefined;
	if (from === to) {
		const head = `\\added[id=${me}]{`;
		const end = from + head.length + insert.length;
		return checked(
			text,
			[{ from, to, insert: `${head}${insert}}` }],
			end,
			{ from, to: end + 1, text: from + head.length },
			me,
		);
	}
	// `old` becomes `\replaced[…]{insert}{old}`.
	const head = `\\replaced[id=${me}]{`;
	const end = from + head.length + insert.length;
	return checked(
		text,
		[
			{ from, to: from, insert: `${head}${insert}}{` },
			{ from: to, to, insert: "}" },
		],
		end,
		{
			from,
			to: to + head.length + insert.length + 3,
			text: from + head.length,
		},
		me,
	);
}

// A deletion of plain text: a new `\deleted`, or a longer own one.
function remove(
	text: string,
	changes: Change[],
	edit: Edit,
	me: string,
	forward: boolean,
): TrackedEdit | undefined {
	const { from, to } = edit;
	if (whyNotWrap(text, edit, "track")) return undefined;
	const own = (c: Change) => c.kind === "deleted" && c.author === me;
	const after = changes.find((c) => own(c) && c.from === to);
	if (after) {
		// `X\deleted[…]{Y}` becomes `\deleted[…]{XY}`.
		const head = text.slice(after.from, after.text.from);
		return checked(
			text,
			[
				{ from, to: from, insert: head },
				{ from: to, to: after.text.from, insert: "" },
			],
			forward ? after.to : from,
			{ from, to: after.to, text: from + head.length },
			me,
		);
	}
	const before = changes.find((c) => own(c) && c.to === from);
	if (before) {
		// `\deleted[…]{Y}X` becomes `\deleted[…]{YX}`.
		return checked(
			text,
			[
				{ from: before.to - 1, to: before.to, insert: "" },
				{ from: to, to, insert: "}" },
			],
			forward ? to : before.from,
			{ from: before.from, to, text: before.text.from },
			me,
		);
	}
	const head = `\\deleted[id=${me}]{`;
	const end = to + head.length + 1;
	return checked(
		text,
		[
			{ from, to: from, insert: head },
			{ from: to, to, insert: "}" },
		],
		forward ? end : from,
		{ from, to: end, text: from + head.length },
		me,
	);
}

// An edit within the new text of the author's own `\added` or `\replaced`.
function inOwn(
	text: string,
	own: Change,
	edit: Edit,
	me: string,
	forward: boolean,
): TrackedEdit | undefined {
	const delta = edit.insert.length - (edit.to - edit.from);
	if (own.text.to - own.text.from + delta > 0) {
		return checked(
			text,
			[edit],
			edit.from + edit.insert.length,
			{ from: own.from, to: own.to + delta, text: own.text.from },
			me,
		);
	}
	if (own.kind === "added") {
		return {
			edits: [{ from: own.from, to: own.to, insert: "" }],
			cursor: own.from,
			tracked: true,
		};
	}
	// `\replaced[…]{}{old}` becomes `\deleted[…]{old}`.
	const old = own.old ?? own.text;
	const options = own.options
		? text.slice(own.options.from, own.options.to)
		: "";
	const head = `\\deleted${options}`;
	const end = own.to - (old.from - 1 - own.from) + head.length;
	return {
		edits: [{ from: own.from, to: old.from - 1, insert: head }],
		cursor: forward ? end : own.from,
		tracked: true,
	};
}

// The edits, when applying them leaves a well-formed macro by `me` at
// `expect` and new text in it that can stay wrapped. (Deleted text was
// checked before wrapping.)
function checked(
	text: string,
	edits: Edit[],
	cursor: number,
	expect: { from: number; to: number; text: number },
	me: string,
): TrackedEdit | undefined {
	const out = applyEdits(text, edits);
	const made = findChanges(out).find((c) => c.from === expect.from);
	if (
		made?.author !== me ||
		made.to !== expect.to ||
		made.text.from !== expect.text ||
		(made.kind !== "deleted" && whyNotWrap(out, made.text, "track"))
	) {
		return undefined;
	}
	return { edits, cursor, tracked: true };
}
