// Citation keys from BibTeX source, without parsing the fields.

/** One bibliography entry. `from`/`to` cover `@type{key`. */
export interface BibEntry {
	key: string;
	/** Entry type in lower case, such as `article`. */
	type: string;
	from: number;
	to: number;
}

const head = /@\s*([A-Za-z]+)\s*([{(])\s*([^\s,{}()=]*)\s*(,?)/g;

/**
 * The entries of a `.bib` file in source order. Tolerant: it never throws,
 * skips `@comment`, `@string` and `@preamble`, skips lines commented out
 * with `%`, and ignores an entry whose key is not yet followed by a comma.
 */
export function bibEntries(text: string): BibEntry[] {
	const out: BibEntry[] = [];
	let skipBodies = true;
	head.lastIndex = 0;
	for (let m = head.exec(text); m; m = head.exec(text)) {
		const type = (m[1] ?? "").toLowerCase();
		const key = m[3] ?? "";
		const lineStart = text.lastIndexOf("\n", m.index) + 1;
		if (text.slice(lineStart, m.index).includes("%")) continue;
		const open = text.indexOf(m[2] ?? "{", m.index);
		const special =
			type === "comment" || type === "string" || type === "preamble";
		if (!special && key && m[4]) {
			const to = text.indexOf(key, open) + key.length;
			out.push({ key, type, from: m.index, to });
		}
		// Skip the body so an `@` inside a field or comment is not an entry.
		// After one body that never closes, stop looking: each further scan
		// would run to the end of the file.
		if (!skipBodies) continue;
		const close = bodyEnd(text, open);
		if (close > 0) head.lastIndex = close;
		else skipBodies = false;
	}
	return out;
}

// Offset just past the delimiter that closes the one at `open`, or -1 when
// the body is not closed yet.
function bodyEnd(text: string, open: number): number {
	const paren = text[open] === "(";
	let level = paren ? 1 : 0;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === "{") level++;
		else if (c === "}") level--;
		else if (paren && c === ")" && level === 1) level = 0;
		if (level === 0) return i + 1;
	}
	return -1;
}
