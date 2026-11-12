// What happens to a user's edit before it reaches the document: in Rich
// mode the hidden changes markup is kept whole (core's guardEdit), and while
// Track changes is on the edit becomes changes markup (core's trackEdit).
import { EditorState, type Extension, Transaction } from "@codemirror/state";
import type { Edit } from "../core/changes/changes";
import { guardEdit } from "../core/changes/guard";
import { trackEdit } from "../core/changes/track";
import { joinSoftBreak } from "../core/latex/plan";

/**
 * A transaction filter for typing, pasting, deleting and cutting. Undo,
 * redo and programmatic changes (accept, reject, reloads) pass untouched.
 *
 * @param guard Keep hidden changes markup whole (Rich mode).
 * @param markup Whether Rich mode shows changes markup; when not, hidden
 *   deleted text is kept whole too.
 * @param authorId Track edits as this author; `null` when tracking is off.
 * @param untracked Called when tracking is on and an edit went in plainly.
 */
export function editFilter(
	guard: boolean,
	markup: boolean,
	authorId: string | null,
	untracked: () => void,
): Extension {
	return EditorState.transactionFilter.of((tr) => {
		if (!tr.docChanged) return tr;
		if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) return tr;
		const edits: Edit[] = [];
		tr.changes.iterChanges((from, to, _f, _t, inserted) =>
			edits.push({ from, to, insert: inserted.toString() }),
		);
		const tell = () => {
			if (authorId) queueMicrotask(untracked);
		};
		// ponytail: several cursors, and IME composition (which must not have
		// its text rewritten mid-way), go in untracked. Track composed text
		// once it is committed if accented typing needs tracking.
		const edit = edits[0];
		if (!edit || edits.length > 1 || tr.isUserEvent("input.type.compose")) {
			tell();
			return tr;
		}
		const text = tr.startState.doc.toString();
		const forward = tr.isUserEvent("delete.forward");
		// Deleting a soft line break's mark joins the lines. TeX reads the
		// break as a space either way, so there is nothing to track.
		const joined = guard ? joinSoftBreak(text, edit, forward) : undefined;
		if (joined) {
			return {
				changes: joined.edits,
				selection: { anchor: joined.cursor },
				annotations: Transaction.userEvent.of("delete"),
			};
		}
		let out = guard ? guardEdit(text, edit, forward, markup) : undefined;
		if (authorId) {
			if (out && out.edits.length > 1) tell();
			else if (!out || out.edits.length === 1) {
				const tracked = trackEdit(
					text,
					out?.edits[0] ?? edit,
					authorId,
					forward,
				);
				if (!tracked.tracked) tell();
				out = tracked;
			}
		}
		if (!out) return tr;
		return {
			changes: out.edits,
			selection: { anchor: out.cursor },
			scrollIntoView: true,
			annotations: Transaction.userEvent.of(
				tr.annotation(Transaction.userEvent) ?? "input",
			),
		};
	});
}
