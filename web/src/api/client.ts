// Typed client for the HTTP contract in specs/architecture.md.

import type { Commit, FileStatus } from "./git";

/** An error response from the server: `{error: {code, message, ...extra}}`. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown>,
	) {
		super(message);
		this.name = "ApiError";
	}
}

function token(): string {
	const meta = document.querySelector<HTMLMetaElement>(
		'meta[name="revisions-token"]',
	);
	return meta?.content ?? "";
}

/**
 * Sends one request with the page token and returns the response. A JSON
 * body is sent when `body` is given. Throws ApiError unless the status is 2xx.
 */
export async function send(
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const headers: Record<string, string> = { "X-Revisions-Token": token() };
	const init: RequestInit = { method, headers };
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(body);
	}
	const response = await fetch(path, init);
	if (response.ok) return response;

	const parsed: unknown = await response.json().catch(() => null);
	const error = (parsed as { error?: Record<string, unknown> } | null)?.error;
	if (typeof error?.code !== "string" || typeof error.message !== "string") {
		throw new ApiError(
			response.status,
			"unknown",
			`The server answered ${response.status}.`,
			{},
		);
	}
	const { code, message, ...extra } = error;
	if (
		code === "auth_required" ||
		code === "auth_override" ||
		code === "auth_changed"
	) {
		window.dispatchEvent(
			new CustomEvent("revisions:auth-problem", { detail: { code, message } }),
		);
	}
	throw new ApiError(response.status, code, message, extra);
}

/** Sends one request and decodes the JSON answer. */
export async function json<T>(
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const answer = await (await send(method, path, body)).json();
	if (answer?.authError) {
		window.dispatchEvent(
			new CustomEvent("revisions:auth-problem", { detail: answer.authError }),
		);
	}
	return answer;
}

// Application routes.

export interface Ping {
	app: string;
	version: string;
}

export function ping(): Promise<Ping> {
	return json("GET", "/api/ping");
}

export type Platform = "darwin" | "linux" | "windows";

export interface Env {
	platform: Platform;
	git: { found: boolean; version: string };
	latexmk: { found: boolean; version: string };
	synctex: { found: boolean };
}

export function getEnv(): Promise<Env> {
	return json("GET", "/api/env");
}

export interface Settings {
	authorId: string;
	authorName: string;
	buildTimeoutSeconds: number;
}

export function getSettings(): Promise<Settings> {
	return json("GET", "/api/settings");
}

/** Every field is required. Error: 400 `bad_settings`. */
export function putSettings(settings: Settings): Promise<Settings> {
	return json("PUT", "/api/settings", settings);
}

/** Cancels running builds and stops the server once it has answered. */
export async function quit(): Promise<void> {
	await send("POST", "/api/quit");
}

export interface UpdateInfo {
	/** The running version, such as `v0.1.0` or `dev`. */
	version: string;
	/** The tag of a newer release, or "". */
	available: string;
	/** That release's page on GitHub, or "". */
	notesUrl: string;
}

export function getUpdate(): Promise<UpdateInfo> {
	return json("GET", "/api/update");
}

/** Asks GitHub at once. Errors: 409 `dev_build`, 502 `check_failed`. */
export function checkForUpdate(): Promise<UpdateInfo> {
	return json("POST", "/api/update/check");
}

/**
 * Installs the newer release; the server then restarts on it. Errors: 409
 * `no_update`, 409 `updating`, 409 `not_writable` and 502 `update_failed`,
 * both with `command`.
 */
export function installUpdate(): Promise<{ version: string }> {
	return json("POST", "/api/update");
}

export interface AuthProblem {
	code: string;
	message: string;
}

export interface Auth {
	problem?: AuthProblem;
	signedIn: boolean;
	/** Null when signed out, and when signed in while GitHub is unreachable. */
	user: { login: string; name: string; avatarUrl: string } | null;
	suggestedAuthorId: string;
}

export function getAuth(): Promise<Auth> {
	return json("GET", "/api/auth");
}

export function reconnectGitHub(): Promise<Auth> {
	return json("POST", "/api/auth/reconnect");
}

export async function cancelDevice(): Promise<void> {
	await send("POST", "/api/auth/device/cancel");
}

export interface DeviceCode {
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	interval: number;
}

/** Error: 503 `not_configured`. */
export function startDevice(): Promise<DeviceCode> {
	return json("POST", "/api/auth/device");
}

export type DevicePoll = "pending" | "ok" | "expired" | "denied";

export async function pollDevice(): Promise<DevicePoll> {
	return (await json<{ status: DevicePoll }>("POST", "/api/auth/device/poll"))
		.status;
}

export function signOut(): Promise<Auth> {
	return json("POST", "/api/auth/signout");
}

/** A repository id: `<host>/<owner>/<name>`. */
export type RepoId = string;

export interface RepoSummary {
	id: RepoId;
	/** The folder that holds the clone. */
	path: string;
	/** A folder linked from elsewhere, rather than a copy in the Revisions folder. */
	linked: boolean;
	/** `remote.origin.url` as Git stores it, or "". */
	origin: string;
	branch: string | null;
	head: string;
}

export function listRepos(): Promise<RepoSummary[]> {
	return json("GET", "/api/repos");
}

export interface Opened {
	repo: RepoId;
	ref: { kind: "branch" | "commit"; name: string; sha: string };
}

/**
 * Brings a clone to a shared URL. Errors: 400 `bad_url`, 401
 * `auth_required`, 404 `not_found`, 409 `dirty` with `files`, 424
 * `git_missing`, 502 `git_failed`.
 */
export function openUrl(url: string): Promise<Opened> {
	return json("POST", "/api/open", { url });
}

/**
 * Uses a Git repository already on this computer, outside the Revisions
 * folder, as the clone of its `origin`. Errors: 400 `bad_request`, 422
 * `bad_repo` when the folder is not set up correctly, 409 `repo_exists`, 424
 * `git_missing`.
 */
export function linkFolder(path: string): Promise<{ repo: RepoId }> {
	return json("POST", "/api/link", { path });
}

/** Opens the clone's folder in the file manager. Error: 500 `open_failed`. */
export async function revealFolder(id: RepoId): Promise<void> {
	await send("POST", `/api/repos/${id}/reveal`);
}

export interface RemovePreview {
	path: string;
	linked: boolean;
	/** Uncommitted changes that removing would lose; empty when linked. */
	files: FileStatus[];
	/** Commits no GitHub branch holds; empty when linked. */
	commits: Commit[];
	/** Names exactly this preview; the removal is refused if it changed. */
	fingerprint: string;
}

/** Error: 409 `not_removable` for a copy reached through a symbolic link. */
export function previewRemove(id: RepoId): Promise<RemovePreview> {
	return json("GET", `/api/repos/${id}/remove/preview`);
}

/** Unlinks a linked folder or deletes a copy in the Revisions folder.
 * Errors as for {@link previewRemove}, and 409 `changed`. */
export async function removeRepo(
	id: RepoId,
	fingerprint: string,
): Promise<void> {
	await send("POST", `/api/repos/${id}/remove`, { fingerprint });
}
