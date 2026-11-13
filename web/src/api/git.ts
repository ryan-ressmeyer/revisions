// The Git and pull-request routes under R of the contract in
// specs/architecture.md. Every POST under git/ answers with the new status.
import { type AuthProblem, json, type RepoId } from "./client";

const R = (id: RepoId) => `/api/repos/${id}`;

export interface FileStatus {
	path: string;
	status:
		| "modified"
		| "added"
		| "deleted"
		| "renamed"
		| "untracked"
		| "conflicted";
}

export interface GitStatus {
	/** Failed optional GitHub lookup; local status remains usable. */
	authError?: AuthProblem;
	branch: string | null;
	head: string;
	upstream: string | null;
	/** The branch tracked a GitHub branch that has since been removed. */
	upstreamGone: boolean;
	ahead: number;
	behind: number;
	files: FileStatus[];
	merging: boolean;
	conflicts: string[];
	permissions: { push: boolean };
	/** The version on screen while HEAD is detached; null on a branch. */
	snapshot: Snapshot | null;
}

export interface Snapshot {
	subject: string;
	/** Author date, ISO 8601. */
	date: string;
	/** The branch that going back switches to; null when there is none. */
	returnTo: string | null;
}

export interface Commit {
	sha: string;
	parents: string[];
	authorName: string;
	date: string;
	subject: string;
	/** `HEAD` and full ref names such as `refs/remotes/origin/main`. */
	refs: string[];
}

export interface PullRequest {
	number: number;
	title: string;
	state: "open" | "closed" | "merged";
	headSha: string;
	headRef: string;
	url: string;
}

export interface CommitDetail {
	sha: string;
	message: string;
	authorName: string;
	date: string;
	diff: string;
}

export function gitStatus(id: RepoId): Promise<GitStatus> {
	return json("GET", `${R(id)}/git/status`);
}

/** `path` is optional and taken literally. */
export async function gitDiff(id: RepoId, path?: string): Promise<string> {
	const q = path === undefined ? "" : `?${new URLSearchParams({ path })}`;
	return (await json<{ diff: string }>("GET", `${R(id)}/git/diff${q}`)).diff;
}

export function gitLog(
	id: RepoId,
	limit = 200,
): Promise<{
	commits: Commit[];
	pulls: PullRequest[];
	authError: AuthProblem | null;
}> {
	return json("GET", `${R(id)}/git/log?limit=${limit}`);
}

export function gitCommitDetail(
	id: RepoId,
	sha: string,
): Promise<CommitDetail> {
	return json("GET", `${R(id)}/git/commits/${encodeURIComponent(sha)}`);
}

/** Errors: 409 `detached`, `conflicts` with `files`, `nothing_to_commit`. */
export function gitCommit(id: RepoId, message: string): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/commit`, { message });
}

export function gitFetch(id: RepoId): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/fetch`);
}

/** Errors: 409 `detached`, `no_upstream`, `upstream_gone`, `dirty` with `files`. */
export function gitPull(id: RepoId): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/pull`);
}

/** Error: 409 `not_merging`. */
export function gitMergeAbort(id: RepoId): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/merge/abort`);
}

/** Errors: 403 `no_push_permission`, 409 `detached`, `rejected`. */
export function gitPush(id: RepoId): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/push`);
}

/** The remote commits a force-push would erase. Error: 409 `detached`. */
export function gitForcePushPreview(
	id: RepoId,
): Promise<{ remoteSha: string; commits: Commit[] }> {
	return json("GET", `${R(id)}/git/force-push/preview`);
}

/** Errors: 403 `no_push_permission`, 409 `detached`, `rejected`. */
export function gitForcePush(
	id: RepoId,
	expectedRemoteSha: string,
): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/force-push`, { expectedRemoteSha });
}

/** Errors: 400 `bad_branch`, 409 `branch_exists`. */
export function gitCreateBranch(id: RepoId, name: string): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/branches`, { name });
}

/** Errors: 404 `not_found`, 409 `dirty` with `files`. */
export function gitCheckout(id: RepoId, branch: string): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/checkout`, { branch });
}

/** Checks out a commit as a read-only snapshot (detached HEAD). Errors as
 * for {@link gitCheckout}. */
export function gitViewVersion(id: RepoId, commit: string): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/checkout`, { commit });
}

export interface DiscardPreview {
	diff: string;
	files: FileStatus[];
	/** Names exactly this preview; the discard is refused if it changed. */
	fingerprint: string;
}

export function gitDiscardPreview(id: RepoId): Promise<DiscardPreview> {
	return json("GET", `${R(id)}/git/discard/preview`);
}

/** Error: 409 `changed` when the changes differ from the preview. */
export function gitDiscard(
	id: RepoId,
	fingerprint: string,
): Promise<GitStatus> {
	return json("POST", `${R(id)}/git/discard`, { fingerprint });
}

/**
 * Opens a pull request from the current branch. `base` defaults to the
 * repository's default branch when empty. Errors: 409 `detached`,
 * `not_pushed`, 422 `pull_rejected`.
 */
export function createPull(
	id: RepoId,
	title: string,
	body: string,
	base = "",
): Promise<PullRequest> {
	return json("POST", `${R(id)}/pulls`, { title, body, base });
}
