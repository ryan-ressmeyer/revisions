import { describe, expect, test } from "vitest";
import { fixture, fixtureFiles, garbage } from "./fixture";
import { type Command, type Env, leaves, type Node, scan } from "./scan";

function tiles(text: string): boolean {
	let at = 0;
	for (const leaf of leaves(scan(text))) {
		if (leaf.from !== at || leaf.to <= leaf.from) return false;
		at = leaf.to;
	}
	return at === text.length;
}

/** First node (depth-first) matching `pred`. */
function find(nodes: Node[], pred: (n: Node) => boolean): Node | undefined {
	for (const node of nodes) {
		if (pred(node)) return node;
		if ("children" in node) {
			const hit = find(node.children, pred);
			if (hit) return hit;
		}
	}
	return undefined;
}

function command(text: string, name: string): Command {
	const node = find(
		scan(text).children,
		(n) => n.kind === "command" && n.name === name,
	);
	if (node?.kind !== "command") throw new Error(`no \\${name}`);
	return node;
}

function env(text: string, name: string): Env {
	const node = find(
		scan(text).children,
		(n) => n.kind === "env" && n.name === name,
	);
	if (node?.kind !== "env") throw new Error(`no env ${name}`);
	return node;
}

describe("scan tiles its input", () => {
	test("the fixture manuscript", () => {
		for (const file of fixtureFiles) expect(tiles(file.text)).toBe(true);
	});

	test("every prefix of the fixture", () => {
		const text = fixture("main.tex");
		for (let i = 0; i <= text.length; i++) {
			if (!tiles(text.slice(0, i))) throw new Error(`prefix ${i} not tiled`);
		}
	});

	test("generated garbage", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const text = garbage(seed, 400);
			if (!tiles(text)) throw new Error(`seed ${seed} not tiled`);
		}
	});

	test("hostile nesting and half-typed input", () => {
		const cases = [
			"",
			"\\",
			"\\begin{",
			"\\end{x}",
			"}}}]]]",
			"$",
			"$$",
			"\\verb",
			"\\verb|abc",
			"\\textbf{",
			"\\item[",
			"\\begin{verbatim}\n\\textbf{",
			"{".repeat(50_000),
			"\\textbf{".repeat(20_000),
			"\\begin{itemize}".repeat(20_000),
			"[".repeat(5000) + "]".repeat(5000),
		];
		for (const text of cases) expect(tiles(text)).toBe(true);
	});
});

describe("scan structure", () => {
	test("known commands take their arguments by signature", () => {
		const text = "\\replaced[id=RR]{new}{old} tail";
		const cmd = command(text, "replaced");
		expect(text.slice(cmd.from, cmd.to)).toBe("\\replaced[id=RR]{new}{old}");
		expect(cmd.args.map((a) => a && text.slice(a.from, a.to))).toEqual([
			"[id=RR]",
			"{new}",
			"{old}",
		]);
	});

	test("an absent optional argument leaves its slot empty", () => {
		const cmd = command("\\section*{Intro}", "section");
		expect(cmd.star).toBe(true);
		expect(cmd.args[0]).toBeUndefined();
		expect(cmd.args[1]?.closed).toBe(true);
	});

	test("a bracket inside braces does not close an optional argument", () => {
		const text = "\\added[id=a, comment={x, ] {y}}]{new}";
		const cmd = command(text, "added");
		const opt = cmd.args[0];
		expect(opt && text.slice(opt.from, opt.to)).toBe(
			"[id=a, comment={x, ] {y}}]",
		);
	});

	test("unknown commands keep the groups that touch them", () => {
		const text = "\\vdeg{0.5} and";
		const cmd = command(text, "vdeg");
		expect(text.slice(cmd.from, cmd.to)).toBe("\\vdeg{0.5}");
	});

	test("comments hide commands, escaped percent does not start one", () => {
		const text = "60\\% done % \\textbf{no}\n\\emph{yes}";
		const root = scan(text);
		expect(find(root.children, (n) => n.kind === "comment")).toMatchObject({
			from: 10,
			to: 23,
		});
		expect(
			find(root.children, (n) => n.kind === "command" && n.name === "textbf"),
		).toBeUndefined();
		expect(command(text, "emph").from).toBe(24);
	});

	test("verb and verbatim bodies are opaque", () => {
		const text =
			"\\verb|\\textbf{a}| \\begin{verbatim}\n\\emph{b} % $\n\\end{verbatim} \\textit{c}";
		const root = scan(text);
		const kinds = root.children.map((n) => n.kind);
		expect(kinds).toContain("verbatim");
		expect(
			find(root.children, (n) => n.kind === "command" && n.name === "textbf"),
		).toBeUndefined();
		expect(
			find(root.children, (n) => n.kind === "command" && n.name === "emph"),
		).toBeUndefined();
		expect(command(text, "textit")).toBeDefined();
	});

	test("math forms", () => {
		const text =
			"$a$ \\(b\\) $$c$$ \\[d\\] \\begin{align*}e\\end{align*} cost \\$5";
		const math = scan(text).children.filter((n) => n.kind === "math");
		expect(
			math.map((m) => [text.slice(m.bodyFrom, m.bodyTo), m.display, m.env]),
		).toEqual([
			["a", false, undefined],
			["b", false, undefined],
			["c", true, undefined],
			["d", true, undefined],
			["e", true, "align*"],
		]);
	});

	test("a dollar nested in \\text does not close inline math", () => {
		const text = "$a \\text{if $b$} c$ d";
		const math = scan(text).children.filter((n) => n.kind === "math");
		expect(math).toHaveLength(1);
		expect(math[0]?.to).toBe(19);
	});

	test("unclosed math stays inside its paragraph", () => {
		const text = "price $5 only\n\n\\textbf{x} $y$";
		const root = scan(text);
		expect(command(text, "textbf")).toBeDefined();
		const math = root.children.filter((n) => n.kind === "math");
		expect(math.map((m) => text.slice(m.from, m.to))).toEqual(["$y$"]);
	});

	test("environments nest and tolerate a stray or missing end", () => {
		const text =
			"\\end{foo}\\begin{itemize}\\item a\\begin{enumerate}\\item b\\end{itemize} tail";
		const outer = env(text, "itemize");
		expect(outer.end).toBeDefined();
		expect(text.slice(outer.to)).toBe(" tail");
		const inner = env(text, "enumerate");
		expect(inner.end).toBeUndefined();
	});

	test("environment arguments attach to the begin command", () => {
		const text = "\\begin{tabular}{lcc}a\\end{tabular}";
		const tab = env(text, "tabular");
		const cols = tab.begin.args[2];
		expect(cols && text.slice(cols.from, cols.to)).toBe("{lcc}");
	});

	test("the fixture has a document environment", () => {
		const text = fixture("main.tex");
		const doc = env(text, "document");
		expect(doc.end).toBeDefined();
		expect(text.slice(doc.begin.from, doc.begin.to)).toBe("\\begin{document}");
	});
});
