// User macros: what a manuscript defines with `\newcommand` and its kin or
// a simple `\def`, read from the source text, and what the inline view does
// with it: hand it to KaTeX for math, and draw plain values in prose.

/** A macro the manuscript defines. */
export interface Macro {
	/** Number of parameters, 0 to 9. */
	params: number;
	/** The default of the first parameter, when that parameter is optional. */
	optional?: string;
	/** The replacement text as written, without its outer braces. */
	body: string;
}

/** Macros by name, without the backslash. */
export type Macros = ReadonlyMap<string, Macro>;

/** One definition and the range it covers. */
export interface Definition {
	name: string;
	macro: Macro;
	/** `\providecommand`, which keeps a definition that already exists. */
	provide: boolean;
	/** Just after the definition's closing brace. */
	to: number;
}

/** Commands that define a macro. `\DeclareRobustCommand` reads like `\newcommand`. */
export const definers = new Set([
	"newcommand",
	"renewcommand",
	"providecommand",
	"DeclareRobustCommand",
	"def",
]);

// ponytail: a definition whose body is longer than this is ignored, as if
// it were not there, which bounds the work on a hostile file. Raise it if a
// real manuscript has a longer macro worth showing.
const maxBody = 10_000;

const defHead = /\s*\\([A-Za-z]+)\s*((?:#[1-9])*)\{/y;
const newHead =
	/\s*\*?\s*(?:\{\s*\\([A-Za-z]+)\s*\}|\\([A-Za-z]+))\s*(?:\[\s*([0-9])\s*\]\s*)?/y;

/**
 * The definition made by `\<command>` (one of {@link definers}) whose name
 * ends at `at`, or undefined for a form it does not understand: a malformed
 * one, a delimited `\def` parameter, a body that does not close, or one over
 * the size limit.
 */
export function definitionAt(
	text: string,
	command: string,
	at: number,
): Definition | undefined {
	if (command === "def") {
		defHead.lastIndex = at;
		const m = defHead.exec(text);
		if (!m?.[1]) return undefined;
		const spec = m[2] ?? "";
		const params = spec.length / 2;
		for (let i = 1; i <= params; i++)
			if (spec[2 * i - 1] !== String(i)) return undefined;
		const open = defHead.lastIndex - 1;
		const close = closing(text, open);
		if (close < 0) return undefined;
		const body = text.slice(open + 1, close);
		return {
			name: m[1],
			macro: { params, body },
			provide: false,
			to: close + 1,
		};
	}
	newHead.lastIndex = at;
	const m = newHead.exec(text);
	const name = m?.[1] ?? m?.[2];
	if (!m || !name) return undefined;
	const params = Number(m[3] ?? 0);
	let p = newHead.lastIndex;
	let optional: string | undefined;
	if (m[3] !== undefined && text[p] === "[") {
		const close = closing(text, p);
		if (close < 0 || params === 0) return undefined;
		optional = text.slice(p + 1, close);
		p = close + 1;
		while (/\s/.test(text[p] ?? "")) p++;
	}
	if (text[p] !== "{") return undefined;
	const close = closing(text, p);
	if (close < 0) return undefined;
	const macro: Macro = { params, body: text.slice(p + 1, close) };
	if (optional !== undefined) macro.optional = optional;
	return {
		name,
		macro,
		provide: command === "providecommand",
		to: close + 1,
	};
}

// The offset of the `}` or `]` that closes the `{` or `[` at `open`, as TeX
// pairs them: escaped braces and comments do not count. -1 when there is
// none within the size limit.
function closing(text: string, open: number): number {
	const bracket = text[open] === "[";
	const end = Math.min(text.length, open + 1 + maxBody);
	let level = 0;
	for (let i = open + 1; i < end; i++) {
		const c = text[i];
		if (c === "\\") i++;
		else if (c === "%") {
			const line = text.indexOf("\n", i);
			if (line < 0) return -1;
			i = line;
		} else if (c === "{") level++;
		else if (c === "}") {
			if (level === 0) return bracket ? -1 : i;
			level--;
		} else if (c === "]" && bracket && level === 0) return i;
	}
	return -1;
}

const plain = /^[^\\{}$%#&^_~]+$/;

/**
 * The text a macro stands for when it takes no parameters and its body is
 * plain text or a number, such as `962` or `[-0.009, +0.004]`, with white
 * space collapsed. Undefined for anything that needs typesetting.
 */
export function macroValue(macro: Macro): string | undefined {
	if (macro.params > 0) return undefined;
	const text = macro.body.replace(/\s+/g, " ").trim();
	return plain.test(text) ? text : undefined;
}

// More than this many characters of macro text in one formula is refused.
// ponytail: the count ignores a body that repeats an argument (`#1#1`),
// which can still grow exponentially, as a `\def` written inside a formula
// already could before user macros were passed. Count argument copies if a
// manuscript ever does that.
const maxExpansion = 20_000;
const controlWord = /\\([A-Za-z]+)/g;

/**
 * KaTeX's `macros` option for the formula `tex`: every user macro it uses,
 * directly or through another macro, written so that KaTeX expands it as
 * LaTeX would. Undefined when it uses none, or when expanding them would
 * write more than 20 000 characters, as a macro that refers to itself
 * would; the formula then fails as an unknown macro does.
 */
export function mathMacros(
	tex: string,
	macros: Macros,
): Record<string, string> | undefined {
	if (macros.size === 0) return undefined;
	const sizes = new Map<string, number>();
	const size = (name: string, macro: Macro): number => {
		const known = sizes.get(name);
		if (known !== undefined) return known;
		sizes.set(name, Number.POSITIVE_INFINITY); // until known: a cycle
		const total =
			macro.body.length + (macro.optional?.length ?? 0) + uses(macro.body);
		sizes.set(name, total);
		return total;
	};
	const uses = (s: string): number => {
		let total = 0;
		for (const [, name = ""] of s.matchAll(controlWord)) {
			const macro = macros.get(name);
			if (!macro) continue;
			total += size(name, macro);
			if (total > maxExpansion) return Number.POSITIVE_INFINITY;
		}
		return total;
	};
	if (uses(tex) > maxExpansion || sizes.size === 0) return undefined;
	const out: Record<string, string> = {};
	for (const name of sizes.keys()) {
		const macro = macros.get(name) as Macro;
		const cs = `\\${name}`;
		if (macro.optional === undefined) {
			out[cs] = forKaTeX(macro.body, macro.params);
			continue;
		}
		// KaTeX has no optional parameters. The bare form takes the default;
		// `\name[…]` meets an undefined macro and fails as one.
		const optional = macro.optional;
		out[cs] = `\\@ifnextchar[{${cs}@optional}{${cs}@default}`;
		out[`${cs}@default`] = forKaTeX(
			macro.body.replace(/#(#|[1-9])/g, (all, d: string) =>
				d === "#" ? all : d === "1" ? optional : `#${Number(d) - 1}`,
			),
			macro.params - 1,
		);
	}
	return out;
}

// KaTeX counts a string macro's parameters from the `#1`, `#2`, … in its
// body. When the body skips one, all are named in a group that
// `\@secondoftwo` drops, so the macro still takes every argument.
function forKaTeX(body: string, params: number): string {
	const named = body.replace(/##/g, "");
	for (let i = 1; i <= params; i++) {
		if (named.includes(`#${i}`)) continue;
		const all = Array.from({ length: params }, (_, k) => `#${k + 1}`).join("");
		return `\\@secondoftwo{${all}}{${body}}`;
	}
	return body;
}
