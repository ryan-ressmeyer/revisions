// Finds `changes` package markup. Editing operations on it live in
// `core/changes`, built on this list.
import { type Command, type Node, type Range, scan } from "./scan";

export type ChangeKind =
	| "added"
	| "deleted"
	| "replaced"
	| "highlight"
	| "comment";

/**
 * One complete `changes` macro. `from`/`to` cover the whole macro, from the
 * backslash to the last closing brace.
 */
export interface Change extends Range {
	kind: ChangeKind;
	/** The `id=` option. */
	author?: string;
	/** The `comment=` option, without its outer braces. */
	comment?: string;
	/** The `[…]` argument including its brackets, when present. */
	options?: Range;
	/**
	 * The inside of the first brace argument: the new text of `\added` and
	 * `\replaced`, the removed text of `\deleted`, the marked text of
	 * `\highlight`, the note of `\comment`.
	 */
	text: Range;
	/** The inside of the second brace argument of `\replaced`: the old text. */
	old?: Range;
}

const kinds = new Set(["added", "deleted", "replaced", "highlight", "comment"]);

/**
 * Every complete `changes` macro in `text`, in source order. A macro nested
 * in another's argument follows its parent. Half-typed macros, and macros in
 * comments, verbatim text, or math, are not listed.
 */
export function findChanges(text: string): Change[] {
	const out: Change[] = [];
	const visit = (nodes: Node[]) => {
		for (const node of nodes) {
			if (node.kind === "command") {
				const change = changeOf(text, node);
				if (change) out.push(change);
			}
			if ("children" in node) visit(node.children);
		}
	};
	visit(scan(text).children);
	return out;
}

/** The change a command node stands for, when it is a complete changes macro. */
export function changeOf(text: string, cmd: Command): Change | undefined {
	if (!kinds.has(cmd.name)) return undefined;
	const [opt, first, second] = cmd.args;
	if (opt && !opt.closed) return undefined;
	if (!first?.closed) return undefined;
	if (cmd.name === "replaced" && !second?.closed) return undefined;
	const options = opt
		? keyValues(text.slice(opt.from + 1, opt.to - 1))
		: undefined;
	return {
		kind: cmd.name as ChangeKind,
		from: cmd.from,
		to: cmd.to,
		author: options?.get("id"),
		comment: options?.get("comment"),
		options: opt && { from: opt.from, to: opt.to },
		text: { from: first.from + 1, to: first.to - 1 },
		old: second && { from: second.from + 1, to: second.to - 1 },
	};
}

// `key=value, key={value, with commas}` split at top-level commas.
function keyValues(source: string): Map<string, string> {
	const out = new Map<string, string>();
	let level = 0;
	let start = 0;
	for (let i = 0; i <= source.length; i++) {
		const c = source[i];
		if (c === "\\" && i + 1 < source.length) i++;
		else if (c === "{") level++;
		else if (c === "}") level--;
		else if (i >= source.length || (c === "," && level === 0)) {
			const item = source.slice(start, i);
			start = i + 1;
			const eq = item.indexOf("=");
			if (eq < 0) continue;
			let value = item.slice(eq + 1).trim();
			if (wrapped(value)) value = value.slice(1, -1);
			out.set(item.slice(0, eq).trim(), value);
		}
	}
	return out;
}

// True when one brace pair encloses the whole value.
function wrapped(value: string): boolean {
	if (!value.startsWith("{") || !value.endsWith("}")) return false;
	let level = 0;
	for (let i = 0; i < value.length - 1; i++) {
		const c = value[i];
		if (c === "\\") i++;
		else if (c === "{") level++;
		else if (c === "}" && --level === 0) return false;
	}
	return true;
}
