import { ApiError } from "../api/client";

// Codes whose server message is accurate but not the best advice for a
// reader who does not use Git. Every other code shows the server's sentence.
const plain: Record<string, string> = {
	bad_url:
		"That is not a link to a manuscript on GitHub. Copy the whole link your co-author sent, starting with https://github.com/, and try again.",
	not_found:
		"GitHub does not show that manuscript to your account. Check the link, and ask your co-author to give your GitHub account access.",
	auth_required: "Sign in with GitHub again to continue.",
	bad_token: "This page is out of date. Reload the page to continue.",
	host_unreachable:
		"Could not reach GitHub. Check your internet connection and try again.",
	// Git and pull requests. The panel adds the way out (a button) itself.
	detached:
		"This copy is a snapshot of one version, not a branch. Create a branch first, so your work has a name.",
	dirty:
		"You have changes that are not committed yet. Commit or discard them first.",
	no_upstream:
		"This branch is only on this computer, so there is nothing to get from GitHub yet. Send it first.",
	rejected:
		"Someone else's changes reached GitHub first. Get latest to combine them with yours, then Send again.",
	no_push_permission:
		"Your GitHub account can read this manuscript but not change it. Ask the author to give your account write access.",
	not_pushed:
		"Your branch has commits that are not on GitHub yet. Send them first, so the pull request includes all of your work.",
	conflicts:
		"Some files still contain conflict markers, the lines that start with <<<<<<< or >>>>>>>. Edit them to keep the text you want, then commit.",
	nothing_to_commit: "There are no changes to commit.",
	branch_exists:
		"A branch with that name already exists. Choose another name, or switch to that branch.",
	not_merging: "No merge is in progress.",
};

/**
 * A sentence for the user plus, for `git_failed`, Git's own message to show
 * collapsed as details.
 */
export function failure(error: unknown): { text: string; details: string } {
	if (isCode(error, "git_failed")) {
		return {
			text: "Git could not finish the job. Nothing else was changed.",
			details: (error as ApiError).message.replace(
				/^Git reported a problem: /,
				"",
			),
		};
	}
	return { text: explain(error), details: "" };
}

/** A sentence for the user about any failure: never a bare error code. */
export function explain(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "git_failed") {
			return `Git could not finish the job. Its message was: ${error.message.replace(/^Git reported a problem: /, "")}`;
		}
		return plain[error.code] ?? error.message;
	}
	return "Revisions is not responding. Check that it is still running, then try again.";
}

export const isCode = (error: unknown, code: string) =>
	error instanceof ApiError && error.code === code;
