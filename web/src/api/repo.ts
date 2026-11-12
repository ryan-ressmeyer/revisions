// The project, file, build, and SyncTeX routes under R of the contract in
// specs/architecture.md. Every function takes the repository id first.
import { json, type RepoId, send } from "./client";

const R = (id: RepoId) => `/api/repos/${id}`;
const query = (params: Record<string, string | number>) =>
	new URLSearchParams(
		Object.entries(params).map(([k, v]) => [k, String(v)]),
	).toString();

export interface ProjectFile {
	path: string;
	kind: "text" | "image" | "other";
	size: number;
}

export interface Project {
	/** `""` when there is nothing to build. */
	entry: string;
	entryCandidates: string[];
	entryFromConfig: boolean;
	engine: string;
	files: ProjectFile[];
}

export function getProject(id: RepoId): Promise<Project> {
	return json("GET", `${R(id)}/project`);
}

/** Error: 400 `bad_entry`. */
export function putEntry(id: RepoId, path: string): Promise<Project> {
	return json("PUT", `${R(id)}/entry`, { path });
}

export type BuildState =
	| "none"
	| "running"
	| "succeeded"
	| "failed"
	| "timeout"
	| "canceled";

export interface RepoState {
	/** SHA-256 of every text file up to 2 MiB. */
	hashes: Record<string, string>;
	/** Changes when a file is added or removed, not when one is edited. */
	tree: string;
	build: { state: BuildState; pdfVersion: number; stale: boolean };
	git: { head: string; branch: string | null; dirty: boolean };
}

export function getState(id: RepoId): Promise<RepoState> {
	return json("GET", `${R(id)}/state`);
}

/** The raw bytes of a file and the hash the server holds for them. */
export async function getFile(
	id: RepoId,
	path: string,
): Promise<{ bytes: ArrayBuffer; hash: string }> {
	const response = await send("GET", `${R(id)}/file?${query({ path })}`);
	return {
		bytes: await response.arrayBuffer(),
		hash: response.headers.get("X-Revisions-Hash") ?? "",
	};
}

/**
 * Saves `text` (with `\n` line breaks) over the version `baseHash`. Errors:
 * 400 `bad_path`, 404 `not_found`, 409 `stale` with `hash`, 422 `not_utf8`.
 */
export function putFile(
	id: RepoId,
	path: string,
	baseHash: string,
	text: string,
): Promise<{ hash: string; written: boolean }> {
	return json("PUT", `${R(id)}/file?${query({ path })}`, { baseHash, text });
}

export interface BuildError {
	/** `""` for a file outside the repository. */
	path: string;
	line: number;
	message: string;
}

export interface BuildStatus {
	state: BuildState;
	startedAt: string | null;
	finishedAt: string | null;
	log: string;
	errors: BuildError[];
	pdfVersion: number;
	stale: boolean;
}

/** Errors: 424 `latexmk_missing`, 409 `no_entry`. */
export function startBuild(id: RepoId): Promise<BuildStatus> {
	return json("POST", `${R(id)}/build`);
}

export function getBuild(id: RepoId): Promise<BuildStatus> {
	return json("GET", `${R(id)}/build`);
}

export function cancelBuild(id: RepoId): Promise<BuildStatus> {
	return json("DELETE", `${R(id)}/build`);
}

/** The last good PDF. Error: 404 `no_pdf`. */
export async function getPdf(id: RepoId): Promise<ArrayBuffer> {
	return (await send("GET", `${R(id)}/pdf`)).arrayBuffer();
}

/** The log of the build that made the last good PDF. Error: 404 `no_pdf`. */
export function getPdfLog(
	id: RepoId,
): Promise<{ log: string; builtAt: string }> {
	return json("GET", `${R(id)}/pdf/log`);
}

/** A rectangle in PDF points from the top-left corner of a page. */
export interface PdfBox {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SourceLocation {
	path: string;
	line: number;
	/** 0 when SyncTeX does not know it. */
	column: number;
}

/** `line` counts from 1, `column` from 0. */
export function synctexForward(
	id: RepoId,
	path: string,
	line: number,
	column: number,
): Promise<PdfBox> {
	return json(
		"GET",
		`${R(id)}/synctex/forward?${query({ path, line, column })}`,
	);
}

/** `x` and `y` are PDF points from the top-left corner of `page`. */
export function synctexInverse(
	id: RepoId,
	page: number,
	x: number,
	y: number,
): Promise<SourceLocation> {
	return json("GET", `${R(id)}/synctex/inverse?${query({ page, x, y })}`);
}
