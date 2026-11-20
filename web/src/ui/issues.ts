// Feedback goes to GitHub's issue forms in .github/ISSUE_TEMPLATE, filled in
// through query parameters named after the forms' field ids. Revisions posts
// nothing itself: the user reads and submits the issue on GitHub.
import { ApiError, type Env } from "../api/client";

export type Kind = "bug" | "idea" | "confusing";

export interface About {
	version: string;
	env: Env | null;
	browser: string;
}

const NEW_ISSUE = "https://github.com/ryan-ressmeyer/revisions/issues/new";
// GitHub refuses URLs much past 8 KB; percent-encoding can triple the text.
const PROBLEM_MAX = 2000;
// Server codes for a failure the user cannot act on, worth reporting.
const UNEXPECTED = new Set([
	"internal",
	"git_failed",
	"host_failed",
	"unknown",
]);

let problem = "";
let about: About = { version: "", env: null, browser: "" };

/** Keeps `error` as the last problem when it is one the user cannot act on. */
export function noteProblem(error: unknown): void {
	if (error instanceof ApiError) {
		if (UNEXPECTED.has(error.code)) problem = `${error.code}: ${error.message}`;
	} else if (error instanceof Error) {
		problem = `${error.name}: ${error.message}`;
	} else if (error !== undefined) {
		problem = String(error);
	}
}

export const lastProblem = () => problem;

/** Records what the report describes Revisions as, once it is known. */
export function setAbout(version: string, env: Env): void {
	about = { version, env, browser: "" };
}

export function issueUrl(kind: Kind, a: About, failure: string): string {
	const lines = [`Revisions ${a.version || "unknown"}`];
	if (a.env) {
		lines.push(
			`Platform: ${a.env.platform}`,
			`Git: ${a.env.git.version || "not found"}`,
			`latexmk: ${a.env.latexmk.version || "not found"}`,
		);
	}
	lines.push(`Browser: ${a.browser}`);
	const p = new URLSearchParams({
		template: `${kind}.yml`,
		environment: lines.join("\n"),
	});
	if (kind === "bug" && failure) {
		p.set(
			"problem",
			failure.length > PROBLEM_MAX
				? `${failure.slice(0, PROBLEM_MAX - 1)}…`
				: failure,
		);
	}
	return `${NEW_ISSUE}?${p}`;
}

/** GitHub's form for `kind`, filled in with what Revisions knows now. */
export const reportUrl = (kind: Kind) =>
	issueUrl(kind, { ...about, browser: navigator.userAgent }, problem);
