// Parses `git diff`-style unified diffs for display.

/** One line of a hunk. */
export interface DiffLine {
	/**
	 * `meta` is a line that is neither old nor new text, such as
	 * `\ No newline at end of file` or anything the parser does not know.
	 */
	kind: "context" | "add" | "delete" | "meta";
	/**
	 * The line without its leading ` `, `+`, or `-`. A `meta` line is kept
	 * whole. A trailing `\r` from a CRLF file is kept.
	 */
	text: string;
	/** 1-based line number in the old file. Null for `add` and `meta`. */
	oldLine: number | null;
	/** 1-based line number in the new file. Null for `delete` and `meta`. */
	newLine: number | null;
}

/** One `@@` section of a file's diff. */
export interface DiffHunk {
	/** The whole `@@ -a,b +c,d @@ heading` line. */
	header: string;
	lines: DiffLine[];
}

/** The diff of one file. */
export interface DiffFile {
	/** Path before the change, relative to the repository. Null for an added file. */
	oldPath: string | null;
	/** Path after the change. Null for a deleted file. */
	newPath: string | null;
	status: "modified" | "added" | "deleted" | "renamed";
	/** True when Git reported a binary change. Such a file has no hunks. */
	binary: boolean;
	/**
	 * The lines before the first hunk, verbatim: `diff --git`, `index`, mode
	 * and rename lines, `---` and `+++`.
	 */
	header: string[];
	hunks: DiffHunk[];
}

// ponytail: two-way hunks only. The `@@@` hunks of a combined (merge) diff
// stay in the file's `header`; parse them here if the server ever sends one.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const ESCAPES: Record<string, string> = {
	a: "\x07",
	b: "\b",
	t: "\t",
	n: "\n",
	v: "\v",
	f: "\f",
	r: "\r",
};

/** Undoes Git's C-style quoting of a path with unusual characters. */
function unquote(path: string): string {
	if (!/^".*"$/.test(path)) return path;
	const encoded = path
		.slice(1, -1)
		.replace(/%/g, "%25")
		.replace(/\\([0-7]{3}|.)/g, (_, c: string) =>
			c.length === 3
				? `%${Number.parseInt(c, 8).toString(16).padStart(2, "0")}`
				: (ESCAPES[c] ?? c),
		);
	try {
		return decodeURIComponent(encoded);
	} catch {
		return path;
	}
}

/** The path named by a `---`, `+++`, or `diff --git` side. Null for `/dev/null`. */
function sidePath(raw: string): string | null {
	const path = unquote(raw.replace(/\t.*$/, ""));
	// Git's prefixes are a/ and b/, or c/ i/ o/ w/ with diff.mnemonicPrefix.
	return path === "/dev/null" ? null : path.replace(/^[abciow]\//, "");
}

/**
 * Parses the text of one or more unified diffs. Never throws. Every input
 * line ends up in exactly one place: a file's `header`, a hunk's `header`,
 * or a hunk line. Text before the first file header becomes a file with
 * null paths.
 */
export function parseDiff(text: string): DiffFile[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();

	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldLine = 0;
	let newLine = 0;
	// Lines the current hunk's header still promises.
	let oldLeft = 0;
	let newLeft = 0;

	const startFile = (): DiffFile => {
		file = {
			oldPath: null,
			newPath: null,
			status: "modified",
			binary: false,
			header: [],
			hunks: [],
		};
		files.push(file);
		hunk = null;
		oldLeft = 0;
		newLeft = 0;
		return file;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const inHunk = oldLeft > 0 || newLeft > 0;

		// Hunk lines start with a space, +, -, or \, so these two are safe.
		if (line.startsWith("diff ")) {
			const f = startFile();
			f.header.push(line);
			// Without a rename both sides name the same path, so the text
			// splits in the middle whatever characters the path holds.
			const sides = line.replace(/^diff (--\S+ )?/, "");
			const half = (sides.length - 1) / 2;
			const a = sidePath(sides.slice(0, half));
			if (sides[half] === " " && a === sidePath(sides.slice(half + 1))) {
				f.oldPath = a;
				f.newPath = a;
			}
			continue;
		}
		const range = HUNK.exec(line);
		if (range) {
			hunk = { header: line, lines: [] };
			(file ?? startFile()).hunks.push(hunk);
			oldLine = Number(range[1]);
			newLine = Number(range[3]);
			oldLeft = range[2] === undefined ? 1 : Number(range[2]);
			newLeft = range[4] === undefined ? 1 : Number(range[4]);
			continue;
		}
		// Inside a hunk `--- x` is a deleted line, so the hunk must be over.
		const next = lines[i + 1] ?? "";
		if (!inHunk && line.startsWith("--- ") && next.startsWith("+++ ")) {
			const f: DiffFile = file && !hunk ? file : startFile();
			f.header.push(line, next);
			f.oldPath = sidePath(line.slice(4));
			f.newPath = sidePath(next.slice(4));
			if (f.oldPath === null) f.status = "added";
			else if (f.newPath === null) f.status = "deleted";
			i++;
			continue;
		}

		if (hunk) {
			const body = line.slice(1);
			if (line.startsWith("+")) {
				hunk.lines.push({
					kind: "add",
					text: body,
					oldLine: null,
					newLine: newLine++,
				});
				newLeft--;
			} else if (line.startsWith("-")) {
				hunk.lines.push({
					kind: "delete",
					text: body,
					oldLine: oldLine++,
					newLine: null,
				});
				oldLeft--;
			} else if (line.startsWith(" ") || (line === "" && inHunk)) {
				// Some tools strip the space from an empty context line.
				hunk.lines.push({
					kind: "context",
					text: body,
					oldLine: oldLine++,
					newLine: newLine++,
				});
				oldLeft--;
				newLeft--;
			} else {
				hunk.lines.push({
					kind: "meta",
					text: line,
					oldLine: null,
					newLine: null,
				});
			}
			continue;
		}

		const f: DiffFile = file ?? startFile();
		f.header.push(line);
		if (line.startsWith("new file mode")) {
			f.status = "added";
			f.oldPath = null;
		} else if (line.startsWith("deleted file mode")) {
			f.status = "deleted";
			f.newPath = null;
		} else if (line.startsWith("rename from ")) {
			f.status = "renamed";
			f.oldPath = unquote(line.slice("rename from ".length));
		} else if (line.startsWith("rename to ")) {
			f.newPath = unquote(line.slice("rename to ".length));
		} else if (
			line.startsWith("Binary files ") ||
			line === "GIT binary patch"
		) {
			f.binary = true;
		}
	}
	return files;
}
