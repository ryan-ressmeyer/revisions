// Builds the fixture manuscript with every kind of markup this module writes,
// with the real `changes` package. Skipped when TeX is not installed.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	addComment,
	addHighlight,
	applyEdits,
	type Edit,
	ensurePreamble,
} from "./changes";
import { trackEdit } from "./track";

const hasLatexmk = spawnSync("latexmk", ["-v"]).status === 0;
const title = `the fixture with comments, tracked changes and new authors compiles${hasLatexmk ? "" : " (skipped: latexmk is not on PATH)"}`;

class Doc {
	constructor(public text: string) {}

	at(needle: string): number {
		const i = this.text.indexOf(needle);
		if (i < 0) throw new Error(`no ${needle}`);
		return i;
	}

	apply(edits: Edit[]): void {
		this.text = applyEdits(this.text, edits);
	}

	comment(needle: string, author: string, note: string): void {
		const from = this.at(needle);
		const r = addComment(
			this.text,
			{ from, to: from + needle.length },
			author,
			note,
		);
		if (!r.ok) throw new Error(`${needle}: ${r.reason}`);
		this.apply(r.edits);
	}

	highlight(needle: string, author: string): void {
		const from = this.at(needle);
		const r = addHighlight(
			this.text,
			{ from, to: from + needle.length },
			author,
		);
		if (!r.ok) throw new Error(`${needle}: ${r.reason}`);
		this.apply(r.edits);
	}

	// Tracked keystrokes from `cursor`: text, "backspace" or "delete".
	keys(cursor: number, strokes: string[], author = "RR"): number {
		for (const key of strokes) {
			const edit =
				key === "backspace"
					? { from: cursor - 1, to: cursor, insert: "" }
					: key === "delete"
						? { from: cursor, to: cursor + 1, insert: "" }
						: { from: cursor, to: cursor, insert: key };
			cursor = this.edit(edit, author, key === "delete");
		}
		return cursor;
	}

	// A tracked edit; returns the cursor.
	edit(edit: Edit, author = "RR", forward = false): number {
		const r = trackEdit(this.text, edit, author, forward);
		if (!r.tracked) throw new Error(`untracked: ${JSON.stringify(edit)}`);
		this.apply(r.edits);
		return r.cursor;
	}

	replace(needle: string, insert: string, author = "RR"): number {
		const from = this.at(needle);
		return this.edit({ from, to: from + needle.length, insert }, author);
	}
}

test.skipIf(!hasLatexmk)(
	title,
	() => {
		const dir = mkdtempSync(join(tmpdir(), "revisions-changes-"));
		cpSync(new URL("../../../../testdata/manuscript", import.meta.url), dir, {
			recursive: true,
		});
		const main = new Doc(readFileSync(join(dir, "main.tex"), "utf8"));
		main.apply(
			ensurePreamble(main.text, { id: "RR", name: "Ryan_R & {co} 100%" }),
		);
		main.apply(ensurePreamble(main.text, { id: "AB", name: "Ada" }));

		main.comment(
			"$g = R_{\\text{post}} / R_{\\text{pre}}$ summarizes",
			"RR",
			"100% of {this} & that_#1 \\ ~^$\nsecond line",
		);
		main.comment("\\textcite{rucci2015} argue", "AB", "Is this fair?");
		// Typing inside commented text nests an \added in the \highlight.
		main.keys(main.at(" argue}") + " argue".length, [..." strongly"]);
		main.replace(
			"small, rapid jumps called \\emph{microsaccades} \\parencite{rolfs2009}",
			"",
		);
		main.replace("of contrast $c$", "");
		const typed = main.replace("drift", "w");
		main.keys(typed, [..."ander"]);
		main.keys(main.at("never still") + 5, Array(5).fill("backspace"));
		main.keys(main.at("not written yet") + 4, Array(8).fill("delete"));
		main.keys(main.at("still.") + 6, [
			..." Truly so, $x^2$ ",
			"\\cite{rolfs2009}",
			".",
		]);
		main.replace("larger", "bigger", "AB");
		main.highlight("steady fixation", "AB");
		main.replace("Low", "");
		writeFileSync(join(dir, "main.tex"), main.text);

		const methodsPath = join(dir, "sections", "methods.tex");
		const methods = new Doc(readFileSync(methodsPath, "utf8"));
		methods.replace("velocity threshold", "speed criterion", "AB");
		methods.comment("below \\vdeg{1}", "AB", "Why 1 degree?");
		writeFileSync(methodsPath, methods.text);

		const out = join(dir, "out");
		const run = spawnSync(
			"latexmk",
			[
				"-norc",
				"-pdf",
				"-interaction=nonstopmode",
				"-halt-on-error",
				"-no-shell-escape",
				`-outdir=${out}`,
				"main.tex",
			],
			{ cwd: dir, encoding: "utf8" },
		);
		const log = run.status === 0 ? "" : readLog(join(out, "main.log"));
		expect(run.status, `${main.text}\n${log}`).toBe(0);
	},
	120_000,
);

function readLog(path: string): string {
	try {
		return readFileSync(path, "utf8").split("\n").slice(-40).join("\n");
	} catch {
		return `no log at ${path}`;
	}
}
