// The tolerant LaTeX scanner. It never throws, and the leaves of its tree
// tile the input exactly. It knows the argument shapes of the commands the
// inline view renders and nothing about what they mean.

/** A half-open range of UTF-16 offsets into the source text. */
export interface Range {
	from: number;
	to: number;
}

/**
 * A node without children.
 * - `text`: plain source, including stray delimiters and unmatched `$`.
 * - `comment`: `%` up to, not including, the line break.
 * - `verbatim`: a whole `\verb|…|`, or the body of a verbatim environment.
 * - `escape`: a control symbol such as `\%`, `\&`, `\,`.
 * - `name`: a control word with its star, such as `\section*`.
 * - `open` / `close`: the delimiters of a {@link Group}.
 */
export interface Leaf extends Range {
	kind: "text" | "comment" | "verbatim" | "escape" | "name" | "open" | "close";
}

/**
 * Math, kept opaque: `$…$`, `\(…\)`, `$$…$$`, `\[…\]`, or a math environment.
 * `from`/`to` include the delimiters; `bodyFrom`/`bodyTo` exclude them.
 * Math never crosses a blank line, so a half-typed `$` stays plain text.
 */
export interface MathNode extends Range {
	kind: "math";
	display: boolean;
	bodyFrom: number;
	bodyTo: number;
	/** Environment name including any star, for `\begin{align*}` forms. */
	env?: string;
}

/** `{…}`, or `[…]` when it is an optional argument. Children include the delimiters. */
export interface Group extends Range {
	kind: "group";
	bracket: boolean;
	/** False when the closing delimiter is missing. */
	closed: boolean;
	children: Node[];
}

/**
 * A control word and its arguments. For a command the scanner knows, `args`
 * follows its signature slot by slot and an absent argument is `undefined`;
 * after a missing mandatory argument the later slots are absent too. For any
 * other command, `args` holds the groups that directly touch it. `\begin` and
 * `\end` carry the environment name as `args[0]`, then the environment's own
 * arguments. `\\` is a command named `\\`.
 */
export interface Command extends Range {
	kind: "command";
	/** Name without the backslash or star. */
	name: string;
	star: boolean;
	args: (Group | undefined)[];
	/** The `name` leaf, then whitespace and argument groups in source order. */
	children: Node[];
}

/**
 * `\begin{name} … \end{name}`. `children` starts with `begin` and ends with
 * `end` when the environment is closed. A verbatim environment has one
 * `verbatim` leaf as its body.
 */
export interface Env extends Range {
	kind: "env";
	/** Name including any star. */
	name: string;
	begin: Command;
	/** Missing when the environment is never closed. */
	end?: Command;
	children: Node[];
}

export type Node = Leaf | MathNode | Group | Command | Env;

/** The scanned document. `children` tile `text` from 0 to `text.length`. */
export interface Root extends Range {
	kind: "root";
	text: string;
	children: Node[];
}

// Argument signatures: `o` optional `[…]`, `m` mandatory `{…}`, `v` a brace
// argument read verbatim (URLs may hold `%`).
const sigs = new Map<string, string>();
function sig(shape: string, names: string): void {
	for (const name of names.split(" ")) sigs.set(name, shape);
}
sig("om", "part chapter section subsection subsubsection paragraph");
sig("om", "subparagraph caption includegraphics bibitem documentclass");
sig("om", "usepackage addbibresource definechangesauthor");
sig("om", "added deleted highlight comment");
sig("omm", "replaced");
sig("m", "emph textbf textit texttt underline textsc textsuperscript");
sig("m", "textsubscript label linelabel graphicspath bibliography");
sig("m", "ref eqref pageref autoref cref Cref nameref lineref");
sig("m", "input include subfile");
sig("oom", "cite citep citet citealp citealt parencite textcite autocite");
sig("oom", "footcite citeauthor citeyear Citep Citet Parencite Textcite");
sig("oom", "Autocite");
sig("o", "item");
sig("mmm", "multicolumn");
sig("v", "url");
sig("vm", "href");

const envSigs = new Map<string, string>();
for (const name of ["figure", "figure*", "table", "table*"]) {
	envSigs.set(name, "o");
}
for (const name of ["itemize", "enumerate", "description"]) {
	envSigs.set(name, "o");
}
envSigs.set("tabular", "om");
envSigs.set("tabular*", "mom");
envSigs.set("tabularx", "mm");

const mathEnvs = new Set(
	["equation", "align", "gather", "multline", "alignat", "flalign"]
		.flatMap((name) => [name, `${name}*`])
		.concat("displaymath", "math"),
);
const verbatimEnvs = new Set(
	"verbatim verbatim* Verbatim lstlisting minted comment".split(" "),
);

// Nesting beyond this is left as plain text so recursion stays bounded.
const maxDepth = 200;

const BACKSLASH = 92;
const LBRACE = 123;
const RBRACE = 125;
const LBRACKET = 91;
const RBRACKET = 93;
const DOLLAR = 36;
const PERCENT = 37;
const NEWLINE = 10;
const STAR = 42;

const special = new Uint8Array(128);
for (const c of [BACKSLASH, LBRACE, RBRACE, RBRACKET, DOLLAR, PERCENT]) {
	special[c] = 1;
}

function isLetter(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

function isBlank(c: number): boolean {
	return c === 32 || c === 9 || c === 13;
}

const ROOT = 0;
const BRACE = 1;
const BRACKET = 2;
const ENV = 3;

let memo: Root | undefined;

/**
 * Scans LaTeX source into a tree. Never throws, on any input. The last
 * result is remembered, so calling it again with the same text is free.
 */
export function scan(text: string): Root {
	if (memo?.text !== text) memo = scanText(text);
	return memo;
}

/** The leaves of a tree in source order. Their ranges tile the text. */
export function leaves(root: Root): (Leaf | MathNode)[] {
	const out: (Leaf | MathNode)[] = [];
	const visit = (nodes: Node[]) => {
		for (const node of nodes) {
			if ("children" in node) visit(node.children);
			else out.push(node);
		}
	};
	visit(root.children);
	return out;
}

function scanText(s: string): Root {
	const n = s.length;
	let pos = 0;
	let depth = 0;
	let openBraces = 0;
	const openEnvs = new Map<string, number>();

	function leaf(kind: Leaf["kind"], from: number, to: number): Leaf {
		pos = to;
		return { kind, from, to };
	}

	// Parses nodes into `out` until this frame's closer (true, not consumed),
	// a closer that belongs to an outer frame (false), or the end of input.
	function children(out: Node[], frame: number, envName?: string): boolean {
		while (pos < n) {
			const c = s.charCodeAt(pos);
			if (c === BACKSLASH) {
				const stop = backslash(out, frame, envName);
				if (stop !== undefined) return stop;
			} else if (c === LBRACE) {
				out.push(depth < maxDepth ? group(false) : leaf("text", pos, pos + 1));
			} else if (c === RBRACE) {
				if (frame === BRACE) return true;
				if (openBraces > 0) return false;
				out.push(leaf("text", pos, pos + 1));
			} else if (c === RBRACKET) {
				if (frame === BRACKET) return true;
				out.push(leaf("text", pos, pos + 1));
			} else if (c === DOLLAR) {
				const display = s.charCodeAt(pos + 1) === DOLLAR;
				const token = display ? "$$" : "$";
				out.push(
					math(pos, pos + token.length, token, display) ??
						leaf("text", pos, pos + token.length),
				);
			} else if (c === PERCENT) {
				const end = s.indexOf("\n", pos);
				out.push(leaf("comment", pos, end < 0 ? n : end));
			} else {
				let end = pos + 1;
				while (end < n && !special[s.charCodeAt(end)]) end++;
				out.push(leaf("text", pos, end));
			}
		}
		return false;
	}

	function backslash(
		out: Node[],
		frame: number,
		envName?: string,
	): boolean | undefined {
		const start = pos;
		const next = s.charCodeAt(pos + 1);
		if (!isLetter(next)) {
			if (pos + 1 >= n) {
				out.push(leaf("text", pos, n));
			} else if (next === BACKSLASH) {
				pos += 2;
				out.push(command(start, "\\", "o"));
			} else {
				const close = next === 40 ? "\\)" : next === LBRACKET ? "\\]" : "";
				const node = close
					? math(pos, pos + 2, close, next === LBRACKET)
					: undefined;
				out.push(node ?? leaf("escape", pos, pos + 2));
			}
			return undefined;
		}
		let end = pos + 2;
		while (isLetter(s.charCodeAt(end))) end++;
		const name = s.slice(pos + 1, end);
		pos = end;
		if (name === "begin" || name === "end") {
			const env = envNameAt(end);
			if (env === undefined) {
				out.push(command(start, name, ""));
			} else if (name === "begin") {
				out.push(environment(start, env));
			} else if (frame === ENV && env === envName) {
				pos = start;
				return true;
			} else if ((openEnvs.get(env) ?? 0) > 0) {
				pos = start;
				return false;
			} else {
				out.push(command(start, name, "m"));
			}
		} else if (name === "verb") {
			out.push(verb(start) ?? command(start, name, ""));
		} else {
			out.push(command(start, name, sigs.get(name)));
		}
		return undefined;
	}

	// `pos` sits just after the control sequence.
	function command(start: number, name: string, shape?: string): Command {
		const kids: Node[] = [];
		const args: (Group | undefined)[] = [];
		let star = false;
		if (shape !== undefined && shape !== "" && s.charCodeAt(pos) === STAR) {
			star = true;
			pos++;
		}
		kids.push({ kind: "name", from: start, to: pos });
		if (shape === undefined) {
			while (depth < maxDepth) {
				const c = s.charCodeAt(pos);
				if (c !== LBRACE && c !== LBRACKET) break;
				const g = group(c === LBRACKET);
				kids.push(g);
				args.push(g);
			}
		} else {
			for (const slot of shape) {
				const g = arg(slot, kids);
				if (!g && slot !== "o") break;
				args.push(g);
			}
		}
		return {
			kind: "command",
			from: start,
			to: pos,
			name,
			star,
			args,
			children: kids,
		};
	}

	function arg(slot: string, kids: Node[]): Group | undefined {
		let p = pos;
		while (isBlank(s.charCodeAt(p))) p++;
		if (slot !== "o" && s.charCodeAt(p) === NEWLINE) {
			p++;
			while (isBlank(s.charCodeAt(p))) p++;
		}
		const opener = slot === "o" ? LBRACKET : LBRACE;
		if (s.charCodeAt(p) !== opener || depth >= maxDepth) return undefined;
		const gap = pos;
		pos = p;
		const g = slot === "v" ? verbatimArg() : group(slot === "o");
		if (!g) {
			pos = gap;
			return undefined;
		}
		if (p > gap) kids.push({ kind: "text", from: gap, to: p });
		kids.push(g);
		return g;
	}

	function group(bracket: boolean): Group {
		const from = pos;
		const kids: Node[] = [leaf("open", pos, pos + 1)];
		depth++;
		if (!bracket) openBraces++;
		const closed = children(kids, bracket ? BRACKET : BRACE);
		if (closed) kids.push(leaf("close", pos, pos + 1));
		depth--;
		if (!bracket) openBraces--;
		return { kind: "group", from, to: pos, bracket, closed, children: kids };
	}

	// A brace argument read without interpretation, on one line.
	function verbatimArg(): Group | undefined {
		const from = pos;
		let level = 0;
		for (let i = pos; i < n; i++) {
			const c = s.charCodeAt(i);
			if (c === NEWLINE) return undefined;
			if (c === LBRACE) level++;
			else if (c === RBRACE && --level === 0) {
				const kids: Node[] = [{ kind: "open", from, to: from + 1 }];
				if (i > from + 1) kids.push({ kind: "text", from: from + 1, to: i });
				kids.push(leaf("close", i, i + 1));
				return {
					kind: "group",
					from,
					to: pos,
					bracket: false,
					closed: true,
					children: kids,
				};
			}
		}
		return undefined;
	}

	// The name in `{name}` at `at`, when it is a plain name on one line.
	function envNameAt(at: number): string | undefined {
		let p = at;
		while (isBlank(s.charCodeAt(p))) p++;
		if (s.charCodeAt(p) !== LBRACE) return undefined;
		const from = p + 1;
		for (let i = from; i < n && i < from + 64; i++) {
			const c = s.charCodeAt(i);
			if (c === RBRACE) return i > from ? s.slice(from, i) : undefined;
			if (special[c] || c === LBRACKET || c === NEWLINE) return undefined;
		}
		return undefined;
	}

	// `pos` sits just after `\begin`; `name` was read by `envNameAt`.
	function environment(start: number, name: string): Node {
		const begin = command(start, "begin", `m${envSigs.get(name) ?? ""}`);
		const endToken = `\\end{${name}}`;
		const kids: Node[] = [begin];
		let closed: boolean;
		if (verbatimEnvs.has(name)) {
			const close = s.indexOf(endToken, pos);
			closed = close >= 0;
			const bodyEnd = closed ? close : n;
			if (bodyEnd > pos) kids.push(leaf("verbatim", pos, bodyEnd));
		} else {
			if (mathEnvs.has(name)) {
				const node = math(start, pos, endToken, name !== "math", name);
				if (node) return node;
			}
			if (depth >= maxDepth) return begin;
			depth++;
			openEnvs.set(name, (openEnvs.get(name) ?? 0) + 1);
			closed = children(kids, ENV, name);
			depth--;
			openEnvs.set(name, (openEnvs.get(name) ?? 1) - 1);
		}
		let end: Command | undefined;
		if (closed) {
			const endStart = pos;
			pos += 4;
			end = command(endStart, "end", "m");
			kids.push(end);
		}
		return {
			kind: "env",
			from: start,
			to: pos,
			name,
			begin,
			end,
			children: kids,
		};
	}

	// `\verb` with its delimited body, when the body ends on the same line.
	function verb(start: number): Leaf | undefined {
		let p = pos;
		if (s.charCodeAt(p) === STAR) p++;
		const delim = s.charCodeAt(p);
		if (Number.isNaN(delim) || isLetter(delim) || isBlank(delim)) {
			return undefined;
		}
		for (let i = p + 1; i < n; i++) {
			const c = s.charCodeAt(i);
			if (c === NEWLINE) break;
			if (c === delim) return leaf("verbatim", start, i + 1);
		}
		return undefined;
	}

	function math(
		from: number,
		bodyFrom: number,
		closer: string,
		display: boolean,
		env?: string,
	): MathNode | undefined {
		const bodyTo = mathEnd(bodyFrom, closer);
		if (bodyTo < 0) return undefined;
		pos = bodyTo + closer.length;
		return { kind: "math", from, to: pos, display, bodyFrom, bodyTo, env };
	}

	// Offset of `closer`, or -1 when the math is not closed before a blank
	// line, an unbalanced `}`, or the end of input.
	// ponytail: a paragraph of n unclosed `$` rescans itself n times. Real
	// paragraphs are small; remember the failed range if this ever shows up.
	function mathEnd(start: number, closer: string): number {
		const dollar = closer.charCodeAt(0) === DOLLAR;
		let level = 0;
		for (let i = start; i < n; i++) {
			const c = s.charCodeAt(i);
			if (c === BACKSLASH) {
				if (!dollar && s.startsWith(closer, i)) return i;
				i++;
			} else if (c === PERCENT) {
				const end = s.indexOf("\n", i);
				if (end < 0) return -1;
				i = end - 1;
			} else if (c === LBRACE) {
				level++;
			} else if (c === RBRACE) {
				if (--level < 0) return -1;
			} else if (c === DOLLAR && level === 0 && dollar) {
				return s.startsWith(closer, i) ? i : -1;
			} else if (c === NEWLINE) {
				let j = i + 1;
				while (isBlank(s.charCodeAt(j))) j++;
				if (s.charCodeAt(j) === NEWLINE) return -1;
			}
		}
		return -1;
	}

	const root: Root = { kind: "root", from: 0, to: n, text: s, children: [] };
	// A closer with no open frame is consumed as plain text by `children`, so
	// one call always reaches the end of input.
	children(root.children, ROOT);
	return root;
}
