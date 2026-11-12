// The cross-file index: labels, citation keys, the include graph, and
// graphics lookup. Everything here works from file text alone, so citations
// and references resolve before the first build.
import { bibEntries } from "../bib/bib";
import { type Node, type Range, scan } from "./scan";

/** A repository text file: path relative to the repository root, `/`-separated. */
export interface SourceFile {
	path: string;
	text: string;
}

/** A range in one file. */
export interface Location extends Range {
	path: string;
}

/** What {@link buildIndex} knows about a set of files. */
export interface ProjectIndex {
	/**
	 * `\label` and `\linelabel` keys, each with every place that defines it.
	 * More than one location means a duplicate label.
	 */
	labels: Map<string, Location[]>;
	/** Citation keys from `.bib` entries and `\bibitem`, with their locations. */
	citations: Map<string, Location[]>;
	/**
	 * For each LaTeX file, the files it pulls in with `\input`, `\include`
	 * or `\subfile`, in source order. Targets that match no file are left out.
	 */
	includes: Map<string, string[]>;
	/** `\graphicspath` directories, relative to the repository root. */
	graphicsPaths: string[];
}

const labelInMath = /\\label\s*\{([^{}]*)\}/g;

/**
 * Indexes every file given. A path ending in `.bib` is read as BibTeX and
 * anything else as LaTeX. Labels and keys from all files are pooled; use
 * {@link includedFiles} to learn which files one entry file reaches.
 *
 * ponytail: rebuilds from scratch on every call, about 1 ms per 50 KB.
 * Cache per-file results by text if a large project makes that visible.
 */
export function buildIndex(files: readonly SourceFile[]): ProjectIndex {
	const index: ProjectIndex = {
		labels: new Map(),
		citations: new Map(),
		includes: new Map(),
		graphicsPaths: [],
	};
	const paths = new Set(files.map((f) => f.path));
	for (const { path, text } of files) {
		if (path.endsWith(".bib")) {
			for (const { key, from, to } of bibEntries(text)) {
				add(index.citations, key, { path, from, to });
			}
			continue;
		}
		const included: string[] = [];
		index.includes.set(path, included);
		const inner = (node: Range | undefined) =>
			node ? text.slice(node.from + 1, node.to - 1).trim() : "";
		const visit = (nodes: Node[]) => {
			for (const node of nodes) {
				if (node.kind === "math") {
					const body = text.slice(node.bodyFrom, node.bodyTo);
					// ponytail: a `\label` in a comment inside math still counts.
					for (const m of body.matchAll(labelInMath)) {
						const from = node.bodyFrom + m.index;
						const key = (m[1] ?? "").trim();
						add(index.labels, key, { path, from, to: from + m[0].length });
					}
					continue;
				}
				if (node.kind === "command") {
					const { name, args, from, to } = node;
					const at = { path, from, to };
					if (name === "label" || name === "linelabel") {
						if (args[0]?.closed) add(index.labels, inner(args[0]), at);
					} else if (name === "bibitem") {
						if (args[1]?.closed) add(index.citations, inner(args[1]), at);
					} else if (
						name === "input" ||
						name === "include" ||
						name === "subfile"
					) {
						const target = args[0]?.closed
							? findUp(inner(args[0]), path, ["", ".tex"], paths)
							: undefined;
						if (target && !included.includes(target)) included.push(target);
					} else if (name === "graphicspath" && args[0]?.closed) {
						for (const entry of args[0].children) {
							if (entry.kind !== "group") continue;
							const dir = join(dirname(path), inner(entry));
							if (dir !== undefined) index.graphicsPaths.push(dir);
						}
					}
				}
				if ("children" in node) visit(node.children);
			}
		};
		visit(scan(text).children);
	}
	return index;
}

/**
 * `entry` followed by every file it includes, directly or through other
 * files, in the order TeX would first read them. Safe on include cycles.
 */
export function includedFiles(index: ProjectIndex, entry: string): string[] {
	const out: string[] = [];
	const visit = (path: string) => {
		if (out.includes(path)) return;
		out.push(path);
		for (const child of index.includes.get(path) ?? []) visit(child);
	};
	visit(entry);
	return out;
}

// The order pdfLaTeX tries, then EPS for the other engines.
const graphicsExtensions = [
	"",
	".pdf",
	".png",
	".jpg",
	".mps",
	".jpeg",
	".jbig2",
	".jb2",
	".PDF",
	".PNG",
	".JPG",
	".JPEG",
	".eps",
];

/**
 * The repository file an `\includegraphics` path refers to, or `undefined`
 * when none matches.
 *
 * @param path The path as written in the source, with or without extension.
 * @param fromFile The file that contains the `\includegraphics`.
 * @param repoFiles Every file path in the repository.
 * @param graphicsPaths `ProjectIndex.graphicsPaths`.
 *
 * It looks in the directory of `fromFile` and each of its parents (TeX
 * resolves against the entry file's directory, which is one of them), then
 * in each `\graphicspath` directory.
 */
export function resolveGraphicsPath(
	path: string,
	fromFile: string,
	repoFiles: ReadonlySet<string>,
	graphicsPaths: readonly string[] = [],
): string | undefined {
	const found = findUp(path, fromFile, graphicsExtensions, repoFiles);
	if (found) return found;
	for (const dir of graphicsPaths) {
		for (const ext of graphicsExtensions) {
			const candidate = join(dir, path + ext);
			if (candidate !== undefined && repoFiles.has(candidate)) return candidate;
		}
	}
	return undefined;
}

// `target` with one of `extensions`, looked up in the directory of
// `fromFile` and then in each parent directory up to the root.
function findUp(
	target: string,
	fromFile: string,
	extensions: readonly string[],
	paths: ReadonlySet<string>,
): string | undefined {
	if (!target) return undefined;
	for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
		for (const ext of extensions) {
			const candidate = join(dir, target + ext);
			if (candidate !== undefined && paths.has(candidate)) return candidate;
		}
		if (dir === "") return undefined;
	}
}

function add(map: Map<string, Location[]>, key: string, at: Location): void {
	if (!key) return;
	const list = map.get(key);
	if (list) list.push(at);
	else map.set(key, [at]);
}

function dirname(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

// Joins and normalises; undefined when the result would leave the root.
function join(dir: string, path: string): string | undefined {
	const out: string[] = [];
	for (const part of `${dir}/${path}`.split("/")) {
		if (part === "" || part === ".") continue;
		if (part !== "..") out.push(part);
		else if (out.pop() === undefined) return undefined;
	}
	return out.join("/");
}
