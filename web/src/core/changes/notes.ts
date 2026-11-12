// Why a build failed because of a comment's margin note. The `changes`
// package draws a comment as a todonotes note in the margin, which is a float:
// in a float, a box, a footnote, or the boxed abstract of some journal
// templates, pdflatex stops with `Float(s) lost`; in a caption or a table cell
// with `Not in outer par mode`.
import { changeOf } from "../latex/changes";
import type { SourceFile } from "../latex/project";
import { type Node, scan } from "../latex/scan";
import { unescapeComment } from "./changes";

/** A comment in a place that cannot hold a margin note. */
export interface PlacedComment {
	path: string;
	/** Line of the comment's macro, counting from 1. */
	line: number;
	/** Where it sits, for a sentence: "a figure", "the abstract". */
	place: string;
	/** The comment as its author wrote it. */
	text: string;
}

export interface MarginNoteTrouble {
	/** What went wrong and what to do, in plain language. */
	explanation: string;
	/** The comments in such places, file by file in source order. */
	comments: PlacedComment[];
}

const noteErrors = /Float\(s\) lost|Not in outer par mode/;

// Environments and commands whose content cannot hold a margin note. The
// abstract is fine in `article` but boxed in templates such as elsarticle.
// ponytail: a fixed list of standard names; a template's own boxes are not
// known, so its comments get the explanation without a name.
const places = new Map<string, string>([
	["abstract", "the abstract"],
	["frontmatter", "the title block"],
	["caption", "a caption"],
	["footnote", "a footnote"],
	...["figure", "figure*", "wrapfigure"].map((n) => [n, "a figure"] as const),
	...["table", "table*", "tabular", "tabular*", "tabularx", "longtable"].map(
		(n) => [n, "a table"] as const,
	),
	...[
		"minipage",
		"parbox",
		"fbox",
		"mbox",
		"makebox",
		"framebox",
		"colorbox",
		"fcolorbox",
	].map((n) => [n, "a box"] as const),
]);

/**
 * An explanation for a failed build whose `errors` include `Float(s) lost` or
 * `Not in outer par mode` while the `.tex` files hold comments, which the
 * changes package draws as margin notes; `undefined` otherwise. A comment is
 * a `\comment`, or any changes macro with a `comment=` option.
 */
export function marginNoteTrouble(
	errors: readonly { message: string }[],
	files: readonly SourceFile[],
): MarginNoteTrouble | undefined {
	if (!errors.some((e) => noteErrors.test(e.message))) return undefined;
	let any = false;
	const comments: PlacedComment[] = [];
	for (const { path, text } of files) {
		if (!path.endsWith(".tex")) continue;
		const visit = (nodes: Node[], place: string | undefined) => {
			for (const node of nodes) {
				let here = place;
				if (node.kind === "env" || node.kind === "command") {
					const change =
						node.kind === "command" ? changeOf(text, node) : undefined;
					if (change?.kind === "comment" || change?.comment !== undefined) {
						any = true;
						if (place) {
							comments.push({
								path,
								line: text.slice(0, node.from).split("\n").length,
								place,
								text: unescapeComment(
									change.kind === "comment"
										? text.slice(change.text.from, change.text.to)
										: (change.comment ?? ""),
								),
							});
						}
					}
					here = places.get(node.name) ?? place;
				}
				if ("children" in node) visit(node.children, here);
			}
		};
		visit(scan(text).children, undefined);
	}
	if (!any) return undefined;
	let explanation =
		"A comment sits where LaTeX cannot place a margin note, for example the abstract of some journal templates, a caption, a footnote, a table, or a boxed area. Move the comment to the text around it, or resolve it, and build again.";
	if (comments.length === 0) {
		explanation +=
			" Revisions could not tell which comment it is: look for one inside a box or another special area of the template.";
	}
	return { explanation, comments };
}
