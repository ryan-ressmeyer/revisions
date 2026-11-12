// Syntax colouring for Source mode, read off the scanner's tree.
import { type Group, type Node, scan } from "./scan";

/**
 * A coloured span of source. `command` covers control words with their star
 * and control symbols such as `\%`; `brace` covers `{ } [ ]` delimiters of
 * arguments and groups; `math` covers a whole math span with its delimiters;
 * `environment` covers the name in `\begin{…}` and `\end{…}`.
 */
export interface SourceToken {
	from: number;
	to: number;
	type: "command" | "comment" | "math" | "brace" | "environment";
}

/**
 * Highlight tokens for `text`, sorted and disjoint. Never throws. Uses the
 * scanner's memo, so it is free after `buildPlan` on the same text.
 */
export function sourceTokens(text: string): SourceToken[] {
	const out: SourceToken[] = [];
	const visit = (nodes: Node[], envGroup?: Group, inName = false) => {
		for (const node of nodes) {
			const { from, to } = node;
			if (node.kind === "name" || node.kind === "escape") {
				out.push({ from, to, type: "command" });
			} else if (node.kind === "comment") {
				out.push({ from, to, type: "comment" });
			} else if (node.kind === "math") {
				out.push({ from, to, type: "math" });
			} else if (node.kind === "open" || node.kind === "close") {
				out.push({ from, to, type: "brace" });
			} else if (node.kind === "text") {
				if (inName) out.push({ from, to, type: "environment" });
			} else if (node.kind === "command") {
				const named = node.name === "begin" || node.name === "end";
				visit(node.children, named ? node.args[0] : undefined);
			} else if (node.kind === "group") {
				visit(node.children, undefined, node === envGroup);
			} else if (node.kind === "env") {
				visit(node.children);
			}
		}
	};
	visit(scan(text).children);
	return out;
}
