import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
	test as base,
	editorText,
	expect,
	type Fake,
	openFileName,
	openFromTree,
	PAPER,
	type Server,
	startFake,
	startServer,
} from "./fixtures";

// Every test here changes the "GitHub" repository, so each gets its own
// fake rather than the worker's shared one.
const test = base.extend<{ fakeArgs: string[]; github: Fake }>({
	fakeArgs: [[], { option: true }],
	github: async ({ fakeArgs }, use) => {
		const fake = await startFake(fakeArgs);
		await use(fake);
		await fake.stop();
	},
	server: async ({ github, serverEnv }, use) => {
		const server = await startServer(github, serverEnv);
		try {
			await use(server);
		} finally {
			await server.stop();
		}
	},
});

const identity = {
	GIT_AUTHOR_NAME: "Ada Example",
	GIT_AUTHOR_EMAIL: "ada@example.com",
	GIT_COMMITTER_NAME: "Ada Example",
	GIT_COMMITTER_EMAIL: "ada@example.com",
};

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...identity },
	}).trim();
}

const bare = (fake: Fake) => join(fake.remotes, "ada/paper.git");

/** A co-author's clone of the "GitHub" repository, to make remote commits. */
function coauthor(fake: Fake) {
	const dir = mkdtempSync(join(tmpdir(), "revisions-coauthor-"));
	git(dir, "clone", "--quiet", bare(fake), ".");
	return {
		git: (...args: string[]) => git(dir, ...args),
		/** Replaces `from` with `to` in a file, commits, and pushes. */
		push(subject: string, from: string, to: string, path = "main.tex") {
			const file = join(dir, path);
			writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
			git(dir, "commit", "--quiet", "-am", subject);
			git(dir, "push", "--quiet", "origin", "HEAD");
			return git(dir, "rev-parse", "HEAD");
		},
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const TITLE = "\\title{Fixational Eye Movements Shape Early Visual Responses}";

const topbar = (page: Page) => page.getByRole("banner");
const editor = (page: Page) => page.getByRole("textbox", { name: "Source" });
const saveStatus = (page: Page) =>
	page.getByRole("region", { name: "Editor" }).getByRole("status");
const panel = (page: Page) =>
	page.getByRole("region", { name: "Changes & history" });
const history = (page: Page) =>
	panel(page).getByRole("list", { name: "History" });
const onDisk = (server: Server, path = "main.tex") =>
	readFileSync(join(server.paper, path), "utf8");

async function open(page: Page, url = PAPER.url) {
	await page.goto("/");
	await page.getByLabel("GitHub link").fill(url);
	await page.getByRole("button", { name: "Open" }).click();
	await expect(editor(page)).toBeVisible({ timeout: 15_000 });
}

async function openPanel(page: Page): Promise<Locator> {
	await page.getByRole("button", { name: /Changes & history/ }).click();
	await expect(history(page)).toBeVisible();
	return panel(page);
}

/** Types `text` at the start of the open file and waits for the save. */
async function typeAtStart(page: Page, text: string) {
	await editor(page).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type(text);
	await expect(saveStatus(page)).toHaveText("Saved");
}

/** Replaces the title line of main.tex in the editor. */
async function retitle(page: Page, title: string) {
	const text = (await editorText(page)).replace(TITLE, `\\title{${title}}`);
	await editor(page).click();
	await page.keyboard.press("Control+a");
	await page.keyboard.insertText(text);
	await expect(saveStatus(page)).toHaveText("Saved");
}

async function commit(page: Page, message: string) {
	const p = panel(page);
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	await p.getByLabel("Describe your changes").fill(message);
	await p.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(history(page).getByRole("listitem").first()).toContainText(
		message,
	);
}

/** The top bar's note on uncommitted and unsent work, beside its button. */
const chip = (page: Page) => topbar(page).locator(".work-chip");
const changesButton = (page: Page) =>
	topbar(page).getByRole("button", { name: /^Changes & history/ });

test("Uncommitted changes: once an edit is saved, the top bar reads Not committed", async ({
	page,
}) => {
	await open(page);
	await expect(changesButton(page)).toHaveAccessibleName("Changes & history");
	await expect(chip(page)).toHaveCount(0);
	await typeAtStart(page, "% not yet committed\n");
	await expect(chip(page)).toHaveText("Not committed");
	await expect(changesButton(page)).toHaveAccessibleName(
		"Changes & history: Not committed",
	);
});

test("Unsent commits: a commit on a branch never sent shows ↑1 in the top bar and on Send, and the signal clears after Send", async ({
	page,
	github,
}) => {
	await open(page);
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Branch…" }).click();
	const branches = page.getByRole("dialog", { name: "Branches" });
	await branches.getByLabel("New branch name").fill("unsent");
	await branches.getByRole("button", { name: "Create and switch" }).click();
	await expect(topbar(page).getByText("on branch unsent")).toBeVisible();

	await typeAtStart(page, "% unsent\n");
	await commit(page, "Not sent yet");
	await expect(p.getByRole("status")).toContainText(
		"Send it when you want your co-authors to see it.",
	);
	await expect(chip(page)).toHaveText("↑1");
	await expect(changesButton(page)).toHaveAccessibleName(
		"Changes & history: 1 commit not sent",
	);
	const send = p.getByRole("button", { name: "Send", exact: true });
	await expect(send.locator(".count")).toHaveText("1");

	await send.click();
	await expect(p.getByRole("status")).toContainText("Sent");
	expect(git(bare(github), "log", "-1", "--format=%s", "unsent")).toBe(
		"Not sent yet",
	);
	await expect(chip(page)).toHaveCount(0);
	await expect(send.locator(".count")).toHaveCount(0);
	await expect(changesButton(page)).toHaveAccessibleName("Changes & history");
});

test("Commits waiting on GitHub: a co-author's push shows ↓1 in the top bar without opening the panel, and it clears after Get latest", async ({
	page,
	github,
}) => {
	await page.clock.install();
	await open(page);
	await expect(chip(page)).toHaveCount(0);
	const other = coauthor(github);
	other.push("Retitle", TITLE, "\\title{Their New Title}");
	other.remove();

	await page.clock.fastForward("05:00");
	await expect(chip(page)).toHaveText("↓1");
	await expect(changesButton(page)).toHaveAccessibleName(
		"Changes & history: 1 commit waiting on GitHub",
	);

	const p = await openPanel(page);
	await p.getByRole("button", { name: /Get latest/ }).click();
	await expect(p.getByRole("status")).toContainText("up to date");
	await expect(chip(page)).toHaveCount(0);
});

test("GitHub unreachable on the top bar: a crossed-out cloud says when GitHub was last reached, and clears once a check reaches it", async ({
	page,
	github,
}) => {
	await page.clock.install();
	await open(page);
	await expect(chip(page)).toHaveCount(0);

	renameSync(bare(github), `${bare(github)}.away`);
	await page.clock.fastForward("05:00");
	await expect(chip(page).locator(".offline")).toBeVisible();
	await expect(chip(page)).toHaveAttribute(
		"title",
		/^GitHub could not be reached since \d/,
	);
	await expect(changesButton(page)).toHaveAccessibleName(
		/^Changes & history: GitHub could not be reached since \d/,
	);

	renameSync(`${bare(github)}.away`, bare(github));
	await page.clock.fastForward("05:00");
	await expect(chip(page)).toHaveCount(0);
});

test("Commit: every change is in the commit, which becomes the newest in the graph, and the top bar signals an unsent commit", async ({
	page,
	server,
}) => {
	await open(page);
	await typeAtStart(page, "% a note for the panel\n");
	writeFileSync(join(server.paper, "notes.txt"), "a new file\n");
	await expect(chip(page)).toHaveText("Not committed");

	const p = await openPanel(page);
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	await expect(
		p.getByRole("listitem").filter({ hasText: "main.tex" }).first(),
	).toContainText("changed");
	await expect(
		p.locator(".diff-add").filter({ hasText: "% a note for the panel" }),
	).toBeVisible();

	await commit(page, "Add a note");
	expect(git(server.paper, "log", "-1", "--format=%s")).toBe("Add a note");
	expect(git(server.paper, "status", "--porcelain")).toBe("");
	expect(
		git(server.paper, "show", "--name-only", "--format=", "HEAD")
			.split("\n")
			.sort(),
	).toEqual(["main.tex", "notes.txt"]);
	await expect(chip(page)).toHaveText("↑1");
	await expect(
		history(page).getByRole("listitem").first().getByText("main", {
			exact: true,
		}),
	).toBeVisible();

	// Selecting a commit shows its message and diff.
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await expect(
		p.getByRole("heading", { name: "Initial manuscript" }),
	).toBeVisible();
	await expect(p.locator(".diff-add").first()).toBeVisible();
});

const review = (page: Page) =>
	page.getByRole("dialog", { name: "Review your changes" });

test("Commit opens the review: Commit… shows the changed files, the diff, and the description, and committing from it commits every change and closes the window", async ({
	page,
	server,
}) => {
	await open(page);
	await typeAtStart(page, "% reviewed before committing\n");
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Commit…" }).click();
	const w = review(page);
	await expect(w.getByRole("list", { name: "Changed files" })).toContainText(
		"main.tex",
	);
	await expect(
		w.locator(".diff-add").filter({ hasText: "% reviewed before committing" }),
	).toBeVisible();

	await w.getByLabel("Describe your changes").fill("Reviewed note");
	await w.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(w).toHaveCount(0);
	expect(git(server.paper, "log", "-1", "--format=%s")).toBe("Reviewed note");
	expect(git(server.paper, "status", "--porcelain")).toBe("");
	await expect(p.getByRole("status")).toContainText(
		"Committed on this computer",
	);
});

test("Jump to a changed line: choosing a line in the review closes it and puts the cursor there, and Commit… brings the description back", async ({
	page,
}) => {
	await open(page);
	await retitle(page, "A Reviewed Title");
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Commit…" }).click();
	const w = review(page);
	await w.getByLabel("Describe your changes").fill("Retitle");

	await w.locator(".diff-add").filter({ hasText: "A Reviewed Title" }).click();
	await expect(w).toHaveCount(0);
	await expect(editor(page)).toBeFocused();
	await expect(page.locator(".cm-activeLine")).toContainText(
		"A Reviewed Title",
	);

	await p.getByRole("button", { name: "Commit…" }).click();
	await expect(review(page).getByLabel("Describe your changes")).toHaveValue(
		"Retitle",
	);
});

test("An earlier commit's changes: the larger window shows that commit's diff, read-only, with no description and no jump", async ({
	page,
}) => {
	await open(page);
	const p = await openPanel(page);
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "Open in a larger window" }).click();
	const w = page.getByRole("dialog", { name: "Changes in this commit" });
	await expect(w.locator(".diff-file").first()).toBeVisible();
	await expect(w.getByLabel("Describe your changes")).toHaveCount(0);
	await expect(w.getByRole("button", { name: /^Line \d/ })).toHaveCount(0);
});

test("Nothing to commit: Commit… is disabled", async ({ page }) => {
	await open(page);
	const p = await openPanel(page);
	await expect(p.getByRole("button", { name: "Commit…" })).toBeDisabled();
});

test("Send: a commit reaches GitHub and the branch shows as in sync", async ({
	page,
	github,
}) => {
	await open(page);
	await typeAtStart(page, "% sent\n");
	await openPanel(page);
	await commit(page, "Send this");
	await panel(page).getByRole("button", { name: "Send", exact: true }).click();
	await expect(panel(page).getByRole("status")).toContainText("Sent");
	expect(git(bare(github), "log", "-1", "--format=%s", "main")).toBe(
		"Send this",
	);
	await expect(
		history(page)
			.getByRole("listitem")
			.first()
			.getByTitle(/in sync with GitHub/),
	).toBeVisible();
});

test("Open a pull request: a branch never sent is sent, and its pull request shows in the graph", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Branch…" }).click();
	const branches = page.getByRole("dialog", { name: "Branches" });
	await branches.getByLabel("New branch name").fill("fix-title");
	await branches.getByRole("button", { name: "Create and switch" }).click();
	await expect(branches).toBeHidden();
	await expect(topbar(page).getByText("on branch fix-title")).toBeVisible();

	await retitle(page, "A Better Title");
	await commit(page, "Improve the title");

	// Not sent yet: one click sends the branch and opens the pull request.
	await p.getByRole("button", { name: "Pull request…" }).click();
	const dialog = page.getByRole("dialog", { name: "Open a pull request" });
	await expect(dialog.getByLabel("New branch name")).toHaveCount(0);
	await dialog.getByLabel("Title").fill("A better title");
	await dialog.getByLabel("Description").fill("Shorter and clearer.");
	await dialog.getByRole("button", { name: "Open pull request" }).click();

	const link = dialog.getByRole("link", { name: /#1/ });
	await expect(link).toHaveAttribute(
		"href",
		"https://github.com/ada/paper/pull/1",
	);
	await dialog.getByRole("button", { name: "Close" }).click();
	const badge = history(page)
		.getByRole("listitem")
		.first()
		.getByRole("link", { name: /Pull request #1/ });
	await expect(badge).toHaveAttribute("target", "_blank");
	expect(git(bare(github), "rev-parse", "fix-title")).toBe(
		git(server.paper, "rev-parse", "HEAD"),
	);
});

/** Opens Pull request… and fills it in; `branch` is the new branch name. */
async function proposeFromMain(page: Page, title: string, branch: string) {
	await panel(page).getByRole("button", { name: "Pull request…" }).click();
	const dialog = page.getByRole("dialog", { name: "Open a pull request" });
	await expect(dialog).toContainText(
		"Uncommitted changes come along to the new branch but are not part of the pull request.",
	);
	await dialog.getByLabel("Title").fill(title);
	await dialog.getByLabel("New branch name").fill(branch);
	await dialog.getByRole("button", { name: "Open pull request" }).click();
	return dialog;
}

test("Pull request from the shared branch: the unsent commits move to a new branch, main matches GitHub again, and the pull request opens", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	await typeAtStart(page, "% revised on main\n");
	await openPanel(page);
	await commit(page, "Revise on main");
	const revised = git(server.paper, "rev-parse", "HEAD");
	await typeAtStart(page, "% not proposed\n");

	const dialog = await proposeFromMain(page, "Revise on main", "ada-revisions");
	await expect(dialog.getByRole("link", { name: /#1/ })).toBeVisible();
	await expect(topbar(page).getByText("on branch ada-revisions")).toBeVisible();
	expect(git(bare(github), "rev-parse", "ada-revisions")).toBe(revised);
	const sent = git(bare(github), "rev-parse", "main");
	expect(git(server.paper, "rev-parse", "main")).toBe(sent);
	expect(git(server.paper, "rev-parse", "origin/main")).toBe(sent);
	// The uncommitted change came along, still uncommitted.
	expect(onDisk(server)).toMatch(/^% not proposed\n% revised on main\n/);
	expect(git(server.paper, "status", "--porcelain")).toBe("M main.tex");
});

test("Nothing to propose: GitHub already has every commit, so nothing changes and the page says so", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	await openPanel(page);
	const refs = () =>
		[
			git(server.paper, "for-each-ref"),
			git(server.paper, "rev-parse", "--symbolic-full-name", "HEAD"),
			git(bare(github), "for-each-ref"),
		].join("\n");
	const before = refs();
	const dialog = await proposeFromMain(page, "Nothing new", "ada-nothing");
	await expect(dialog.getByRole("alert")).toContainText(
		"nothing to propose yet",
	);
	expect(refs()).toBe(before);
});

test("Pull request step fails: the page says the branch was made and main moved, nothing was sent, and why, with no retry", async ({
	page,
	github,
	server,
}) => {
	writeFileSync(
		join(bare(github), "hooks", "pre-receive"),
		"#!/bin/sh\necho 'closed for the test' >&2\nexit 1\n",
		{ mode: 0o755 },
	);
	await open(page);
	await typeAtStart(page, "% revised\n");
	await openPanel(page);
	await commit(page, "Revise");
	let pulls = 0;
	let pushes = 0;
	page.on("request", (r) => {
		if (r.method() !== "POST") return;
		if (r.url().endsWith("/pulls")) pulls++;
		if (r.url().includes("/git/push")) pushes++;
	});

	const dialog = await proposeFromMain(page, "Revise", "ada-fails");
	const alert = dialog.getByRole("alert");
	await expect(alert).toContainText("Branch ada-fails was created");
	await expect(alert).toContainText(
		"Branch main was moved back to match GitHub",
	);
	await expect(alert).toContainText("Nothing was sent to GitHub");
	await expect(alert).toContainText("pre-receive hook declined");
	await expect(topbar(page).getByText("on branch ada-fails")).toBeVisible();
	expect(git(server.paper, "rev-parse", "main")).toBe(
		git(server.paper, "rev-parse", "origin/main"),
	);
	expect(git(bare(github), "branch", "--list", "ada-fails")).toBe("");
	expect([pulls, pushes]).toEqual([1, 0]);
});

test.describe("read-only account", () => {
	test.use({ fakeArgs: ["-push=false"] });

	test("No write access: opening the project says sharing needs write access, the commit box repeats it, and Send, Force-push, and pull requests are not offered", async ({
		page,
	}) => {
		await open(page);
		await expect(
			page
				.getByRole("status")
				.filter({ hasText: "Sharing needs write access" }),
		).toContainText("the author grants on GitHub");
		await typeAtStart(page, "% local only\n");
		const p = await openPanel(page);
		await expect(p).toContainText("can read this manuscript but not change it");
		await expect(p.getByRole("button", { name: "Get latest" })).toBeVisible();
		await expect(p.getByRole("button", { name: "Send" })).toHaveCount(0);
		await expect(p.getByRole("button", { name: /Force-push/ })).toHaveCount(0);
		await expect(p.getByRole("button", { name: /pull request/i })).toHaveCount(
			0,
		);
		await p.getByRole("button", { name: /Uncommitted changes/ }).click();
		await expect(p.locator(".commit-form")).toContainText(
			"Sharing needs write access, which the author grants on GitHub.",
		);
		await commit(page, "Kept on this computer");
	});
});

test("Force-push: lists the remote commits to erase and pushes only after the confirm", async ({
	page,
	github,
}) => {
	await open(page);
	const other = coauthor(github);
	other.push("Theirs one", "% Visual angle", "% One");
	const theirs = other.push("Theirs two", "% One", "% Two");
	other.remove();

	await typeAtStart(page, "% mine\n");
	const p = await openPanel(page);
	await commit(page, "Mine");
	await p.getByRole("button", { name: "Force-push…" }).click();
	const dialog = page.getByRole("dialog", { name: /Force-push/ });
	await expect(dialog.getByRole("listitem")).toHaveCount(2);
	await expect(dialog.getByRole("listitem")).toContainText([
		"Theirs two",
		"Theirs one",
	]);
	await expect(dialog.getByRole("listitem").first()).toContainText(
		"Ada Example",
	);
	expect(git(bare(github), "rev-parse", "main")).toBe(theirs);

	await dialog
		.getByRole("button", { name: "Erase these 2 commits and send mine" })
		.click();
	await expect(dialog).toBeHidden();
	expect(git(bare(github), "log", "-1", "--format=%s", "main")).toBe("Mine");
});

test("Force-push: when GitHub moves after the preview, nothing is pushed and the list is refreshed", async ({
	page,
	github,
}) => {
	await open(page);
	const other = coauthor(github);
	other.push("Theirs one", "% Visual angle", "% One");

	await typeAtStart(page, "% mine\n");
	const p = await openPanel(page);
	await commit(page, "Mine");
	await p.getByRole("button", { name: "Force-push…" }).click();
	const dialog = page.getByRole("dialog", { name: /Force-push/ });
	await expect(dialog.getByRole("listitem")).toHaveCount(1);

	const moved = other.push("Theirs late", "% One", "% Late");
	other.remove();
	await dialog
		.getByRole("button", { name: "Erase this commit and send mine" })
		.click();
	await expect(dialog.getByRole("alert")).toContainText("changed");
	await expect(dialog.getByRole("listitem")).toHaveCount(2);
	await expect(
		dialog.getByRole("button", { name: "Erase these 2 commits and send mine" }),
	).toBeVisible();
	expect(git(bare(github), "rev-parse", "main")).toBe(moved);
});

test("Discard: shows the diff and restores the file only after the confirm", async ({
	page,
	server,
}) => {
	await open(page);
	const original = onDisk(server);
	await typeAtStart(page, "% throw this away\n");
	const p = await openPanel(page);
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	await p.getByRole("button", { name: "Discard changes…" }).click();
	const dialog = page.getByRole("dialog", { name: /Discard/ });
	await expect(dialog.getByText("main.tex").first()).toBeVisible();
	await expect(dialog.locator(".diff-add")).toContainText("% throw this away");
	expect(onDisk(server)).toBe(`% throw this away\n${original}`);

	await dialog.getByRole("button", { name: "Discard these changes" }).click();
	await expect(dialog).toBeHidden();
	expect(onDisk(server)).toBe(original);
	await expect(editor(page)).not.toContainText("% throw this away");
});

test("Discard: a change made after the preview is not discarded, and the preview is refreshed", async ({
	page,
	server,
}) => {
	await open(page);
	await typeAtStart(page, "% throw this away\n");
	const p = await openPanel(page);
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	await p.getByRole("button", { name: "Discard changes…" }).click();
	const dialog = page.getByRole("dialog", { name: /Discard/ });
	await expect(dialog.locator(".diff-add")).toContainText("% throw this away");

	writeFileSync(join(server.paper, "late.tex"), "written after the preview\n");
	await dialog.getByRole("button", { name: "Discard these changes" }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"nothing was discarded",
	);
	await expect(dialog.getByText("late.tex").first()).toBeVisible();
	expect(onDisk(server, "late.tex")).toBe("written after the preview\n");
	expect(onDisk(server)).toContain("% throw this away");
});

test("Get latest: a fast-forward brings the co-author's text into the editor", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	const other = coauthor(github);
	const theirs = other.push("Retitle", TITLE, "\\title{Their New Title}");
	other.remove();

	const p = await openPanel(page);
	await p.getByRole("button", { name: "Get latest" }).click();
	await expect(p.getByRole("status")).toContainText("up to date");
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(theirs);
	expect(await editorText(page)).toContain("\\title{Their New Title}");
});

/** Commits a title change here and a different one on GitHub, then pulls. */
async function conflict(page: Page, github: Fake) {
	await open(page);
	const other = coauthor(github);
	other.push("Their title", TITLE, "\\title{Their Title}");
	other.remove();
	const p = await openPanel(page);
	await retitle(page, "My Title");
	await commit(page, "My title");
	await p.getByRole("button", { name: "Get latest" }).click();
	const banner = p
		.getByRole("alert")
		.filter({ has: page.getByRole("button", { name: "Undo this merge" }) });
	await expect(banner.getByRole("button", { name: "main.tex" })).toBeVisible();
	return banner;
}

test("Get latest: a conflict is resolved in the editor and the commit finishes the merge", async ({
	page,
	github,
	server,
}) => {
	const banner = await conflict(page, github);
	await banner.getByRole("button", { name: "main.tex" }).click();
	await expect(openFileName(page)).toHaveText("main.tex");
	await expect(
		page.getByRole("button", { name: "Source", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	const text = await editorText(page);
	expect(text).toContain("<<<<<<<");

	// Committing with the markers still in is refused, with a reason.
	const p = panel(page);
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	await p.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(
		p.getByRole("alert").filter({ hasText: "still contain conflict markers" }),
	).toBeVisible();

	const resolved = text.replace(
		/<<<<<<<[^\n]*\n[^\n]*\n=======\n[^\n]*\n>>>>>>>[^\n]*\n/,
		"\\title{Our Title}\n",
	);
	expect(resolved).not.toContain("<<<<<<<");
	await editor(page).click();
	await page.keyboard.press("Control+a");
	await page.keyboard.insertText(resolved);
	await expect(saveStatus(page)).toHaveText("Saved");

	await p.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(banner).toBeHidden();
	await expect(history(page).getByRole("listitem").first()).toContainText(
		"Combine my changes with the latest from GitHub",
	);
	expect(
		git(server.paper, "rev-list", "--parents", "-1", "HEAD").split(" "),
	).toHaveLength(3);
	expect(onDisk(server)).toContain("\\title{Our Title}");
});

test("Get latest: Undo this merge puts the copy back as it was", async ({
	page,
	github,
	server,
}) => {
	const banner = await conflict(page, github);
	await banner.getByRole("button", { name: "Undo this merge" }).click();
	await expect(banner).toBeHidden();
	expect(onDisk(server)).toContain("\\title{My Title}");
	expect(git(server.paper, "status", "--porcelain")).toBe("");
	expect(await editorText(page)).toContain("\\title{My Title}");
});

test("Branch removed on GitHub: Get latest explains it and Send puts it back", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Branch…" }).click();
	const branches = page.getByRole("dialog", { name: "Branches" });
	await branches.getByLabel("New branch name").fill("fix-title");
	await branches.getByRole("button", { name: "Create and switch" }).click();
	await expect(branches).toBeHidden();
	await retitle(page, "A Better Title");
	await commit(page, "Improve the title");
	await p.getByRole("button", { name: "Send", exact: true }).click();
	await expect(p.getByRole("status")).toContainText("Sent");

	// The pull request is closed and its branch deleted on GitHub.
	git(bare(github), "branch", "-D", "fix-title");
	const before = onDisk(server);
	await p.getByRole("button", { name: "Get latest" }).click();
	const problem = p
		.getByRole("alert")
		.filter({ hasText: "removed from GitHub" });
	await expect(problem).toBeVisible();
	await expect(problem).not.toContainText("@{upstream}");
	await expect(
		p.getByText(/fix-title, which was removed from GitHub/),
	).toBeVisible();
	expect(onDisk(server)).toBe(before);

	await problem.getByRole("button", { name: "Send" }).click();
	await expect(p.getByRole("status")).toContainText("Sent");
	expect(git(bare(github), "log", "-1", "--format=%s", "fix-title")).toBe(
		"Improve the title",
	);
	await expect(p.getByText(/fix-title · in sync with GitHub/)).toBeVisible();
});

/** Counts the page's fetches from GitHub as they are sent. */
function countFetches(page: Page) {
	const fetches = { sent: 0 };
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().endsWith("/git/fetch")) fetches.sent++;
	});
	return fetches;
}

test("Check on opening: commits pushed while the project was closed show as waiting, without pressing anything", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	await page.goto("/");
	await expect(page.getByLabel("GitHub link")).toBeVisible();
	const other = coauthor(github);
	const theirs = other.push("Retitle", TITLE, "\\title{Their New Title}");
	other.remove();
	expect(git(server.paper, "rev-parse", "origin/main")).not.toBe(theirs);

	const fetches = countFetches(page);
	await page.goto(`/#/r/${PAPER.id}`);
	await expect(editor(page)).toBeVisible({ timeout: 15_000 });
	// Opening the project fetched, before Changes & history was opened.
	await expect
		.poll(() => git(server.paper, "rev-parse", "origin/main"))
		.toBe(theirs);
	expect(fetches.sent).toBe(1);

	const p = await openPanel(page);
	await expect(p.getByText("1 commit waiting on GitHub")).toBeVisible();
	expect(git(server.paper, "rev-parse", "HEAD")).not.toBe(theirs);
});

test("Periodic check: a commit pushed while the project is open shows as waiting within 5 minutes", async ({
	page,
	github,
}) => {
	const fetches = countFetches(page);
	await page.clock.install();
	await open(page);
	const p = await openPanel(page);
	// The checks on opening the project and the panel finish.
	await page.waitForTimeout(1000);
	const before = fetches.sent;
	const other = coauthor(github);
	other.push("Retitle", TITLE, "\\title{Their New Title}");
	other.remove();

	await page.clock.fastForward("04:00");
	await page.waitForTimeout(1000);
	expect(fetches.sent).toBe(before);
	await expect(p.getByText(/waiting on GitHub/)).toHaveCount(0);

	await page.clock.fastForward("01:30");
	await expect(p.getByText("1 commit waiting on GitHub")).toBeVisible();
	expect(fetches.sent).toBe(before + 1);
});

test("Check on returning to the page: a co-author's push shows in the top bar as soon as the page regains focus, beside the commits not yet sent", async ({
	page,
	github,
	server,
}) => {
	const fetches = countFetches(page);
	await open(page);
	// The check on opening the project finishes.
	await page.waitForTimeout(1000);
	const before = fetches.sent;
	const other = coauthor(github);
	other.push("Retitle", TITLE, "\\title{Their New Title}");
	other.remove();
	git(server.paper, "commit", "--quiet", "--allow-empty", "-m", "Mine");

	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(chip(page)).toHaveText("↑1 ↓1");
	await expect(changesButton(page)).toHaveAccessibleName(
		"Changes & history: 1 commit not sent · 1 commit waiting on GitHub",
	);
	expect(fetches.sent).toBe(before + 1);
});

test("GitHub unreachable: the panel says when GitHub was last reached, and editing, committing, and building continue", async ({
	page,
	github,
	server,
}) => {
	test.setTimeout(120_000);
	await page.clock.install();
	await open(page);
	const p = await openPanel(page);
	await expect(p.getByText("Checked GitHub just now")).toBeVisible();

	renameSync(bare(github), `${bare(github)}.away`);
	await page.clock.fastForward("05:00");
	await expect(
		p.getByText(
			"GitHub could not be reached. It was last reached 5 minutes ago, so your copy may be out of date.",
		),
	).toBeVisible();
	await expect(page.locator("dialog[open]")).toHaveCount(0);

	await typeAtStart(page, "% written offline\n");
	expect(onDisk(server)).toContain("% written offline");
	await commit(page, "Offline note");
	expect(git(server.paper, "log", "-1", "--format=%s")).toBe("Offline note");
	await expect(p.getByText(/GitHub could not be reached/)).toBeVisible();

	await page.getByRole("button", { name: "Build PDF" }).click();
	await expect(page.locator('[data-page="1"] canvas')).toHaveCount(1, {
		timeout: 60_000,
	});

	// Get latest reaches GitHub too, so the message clears.
	renameSync(`${bare(github)}.away`, bare(github));
	await p.getByRole("button", { name: /Get latest/ }).click();
	await expect(p.getByText("Checked GitHub just now")).toBeVisible();
	await expect(p.getByText(/GitHub could not be reached/)).toHaveCount(0);
});

test("Branch: create a branch and switch to it", async ({ page, server }) => {
	await open(page);
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Branch…" }).click();
	const dialog = page.getByRole("dialog", { name: "Branches" });
	await dialog.getByLabel("New branch name").fill("notes");
	await dialog.getByRole("button", { name: "Create and switch" }).click();
	await expect(topbar(page).getByText("on branch notes")).toBeVisible();
	expect(git(server.paper, "branch", "--show-current")).toBe("notes");
});

/** Pushes a branch "draft" with its own title to GitHub. */
function pushDraft(github: Fake) {
	const other = coauthor(github);
	other.git("switch", "--quiet", "-c", "draft");
	other.push("Draft title", TITLE, "\\title{Draft Title}");
	other.remove();
}

/** Chooses Switch for `name` in the Branches dialog. */
async function switchTo(page: Page, name: string) {
	await panel(page).getByRole("button", { name: "Branch…" }).click();
	await page
		.getByRole("dialog", { name: "Branches" })
		.getByRole("button", { name: `Switch to ${name}` })
		.click();
}

/** The move prompt, whose title names the destination. */
const prompt = (page: Page, destination: string | RegExp) =>
	page.getByRole("dialog", { name: destination });

test("Commit and move: Commit in the prompt commits every change, then switches branch", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	pushDraft(github);
	await typeAtStart(page, "% unfinished\n");
	writeFileSync(join(server.paper, "notes.tex"), "% my notes\n");
	await openPanel(page);
	await switchTo(page, "draft");

	const dialog = prompt(page, "Switch to branch draft");
	await expect(
		dialog.getByRole("list", { name: "Changed files" }),
	).toContainText("main.tex");
	await expect(
		dialog.getByRole("list", { name: "Changed files" }),
	).toContainText("notes.tex");
	const description = dialog.getByLabel("Describe your changes");
	await expect(description).toHaveValue("");
	await description.fill("Keep my notes");
	await dialog.getByRole("button", { name: "Commit", exact: true }).click();

	await expect(dialog).toBeHidden();
	await expect(topbar(page).getByText("on branch draft")).toBeVisible();
	expect(await editorText(page)).toContain("\\title{Draft Title}");
	expect(git(server.paper, "log", "-1", "--format=%s", "main")).toBe(
		"Keep my notes",
	);
	expect(
		git(server.paper, "show", "--name-only", "--format=", "main").split("\n"),
	).toEqual(["main.tex", "notes.tex"]);
	expect(git(server.paper, "status", "--porcelain")).toBe("");
});

test("Discard and move: Discard in the prompt shows the diff, discards after the confirm, then switches branch", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	pushDraft(github);
	const main = git(server.paper, "rev-parse", "main");
	await typeAtStart(page, "% unfinished\n");
	await openPanel(page);
	await switchTo(page, "draft");

	const dialog = prompt(page, "Switch to branch draft");
	await dialog.getByRole("button", { name: "Discard…" }).click();
	const discard = page.getByRole("dialog", { name: /Discard/ });
	await expect(discard.locator(".diff-add")).toContainText("% unfinished");
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	await discard.getByRole("button", { name: "Discard these changes" }).click();

	await expect(dialog).toBeHidden();
	await expect(topbar(page).getByText("on branch draft")).toBeVisible();
	expect(await editorText(page)).toContain("\\title{Draft Title}");
	expect(git(server.paper, "rev-parse", "main")).toBe(main);
	expect(git(server.paper, "status", "--porcelain")).toBe("");
	expect(await editorText(page)).not.toContain("% unfinished");
});

/** The header text on a snapshot, where the branch name would be. */
const readOnly = (page: Page) =>
	topbar(page).getByRole("button", { name: "Read-only: earlier version" });
/** The dialog the header opens on a snapshot. */
const versionDialog = (page: Page) =>
	page.getByRole("dialog", { name: "This is an earlier version" });

/** Opens the header's dialog and chooses Return to `branch`. */
async function returnTo(page: Page, branch: string) {
	await readOnly(page).click();
	await versionDialog(page)
		.getByRole("button", { name: `Return to ${branch}` })
		.click();
}

/** Commits a later title, then views the first commit from the history. */
async function viewFirst(page: Page) {
	await open(page);
	const p = await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "View this version" }).click();
	await expect(readOnly(page)).toBeVisible();
}

/** Types at the start of the open file and checks that nothing changed. */
async function typingIsRefused(page: Page, server: Server) {
	const disk = onDisk(server);
	await editor(page).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("% not allowed\n");
	expect(await editorText(page)).not.toContain("% not allowed");
	await expect(saveStatus(page)).toHaveText("Saved");
	expect(onDisk(server)).toBe(disk);
}

test("View an earlier version: the editor shows the files as they were, refuses edits, and the header reads Read-only: earlier version", async ({
	page,
	server,
}) => {
	await open(page);
	const p = await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	await expect(readOnly(page)).toHaveCount(0);

	// Selecting an earlier commit offers to view it; the latest one does not.
	await expect(
		p.getByRole("button", { name: "View this version" }),
	).toHaveCount(0);
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "View this version" }).click();
	await expect(readOnly(page)).toBeVisible();
	await expect(topbar(page).getByText(/on branch|at version/)).toHaveCount(0);
	await expect.poll(() => editorText(page)).toContain(TITLE);
	expect(git(server.paper, "branch", "--show-current")).toBe("");
	await typingIsRefused(page, server);
	// No banner or strip: the header is the only indicator.
	await expect(
		page.getByRole("region", { name: "Earlier version" }),
	).toHaveCount(0);
	await expect(page.locator(".banner")).toHaveCount(0);
});

test("Read-only reason: the header opens a dialog that names the version by date and subject, says why, and offers Return and Start a branch here", async ({
	page,
	server,
}) => {
	await viewFirst(page);
	const date = git(server.paper, "log", "-1", "--format=%aI", "HEAD");
	await readOnly(page).click();
	const dialog = versionDialog(page);
	await expect(dialog).toContainText("Initial manuscript");
	await expect(dialog.locator("time")).toHaveAttribute("datetime", date);
	await expect(dialog).toContainText("cannot be changed");
	for (const name of ["Return to main", "Start a branch here", "Close"])
		await expect(
			dialog.getByRole("button", { name, exact: true }),
		).toBeVisible();

	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
	expect(git(server.paper, "branch", "--show-current")).toBe("");
});

test("Back to the branch: Return puts the clone on its branch again, and the editor accepts edits", async ({
	page,
	server,
}) => {
	await viewFirst(page);
	await returnTo(page, "main");
	await expect(versionDialog(page)).toBeHidden();
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	await expect(readOnly(page)).toHaveCount(0);
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	await expect.poll(() => editorText(page)).toContain("A Later Title");
	await typeAtStart(page, "% editable again\n");
	expect(onDisk(server)).toContain("% editable again");
});

test("Back to the branch: with uncommitted changes on a snapshot, Return shows the prompt without Commit, and Discard then returns", async ({
	page,
	server,
}) => {
	await viewFirst(page);
	writeFileSync(join(server.paper, "stray.tex"), "% made while detached\n");
	await returnTo(page, "main");
	const dialog = prompt(page, "Return to branch main");
	await expect(
		dialog.getByRole("list", { name: "Changed files" }),
	).toContainText("stray.tex");
	await expect(
		dialog.getByRole("button", { name: "Commit", exact: true }),
	).toHaveCount(0);
	expect(git(server.paper, "branch", "--show-current")).toBe("");

	await dialog.getByRole("button", { name: "Discard…" }).click();
	await page
		.getByRole("dialog", { name: /Discard/ })
		.getByRole("button", { name: "Discard these changes" })
		.click();
	await expect(dialog).toBeHidden();
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	expect(git(server.paper, "status", "--porcelain")).toBe("");
});

test("Refused text on a snapshot: Return goes ahead, and the refused text stays shown for copying, saved nowhere", async ({
	page,
	server,
}) => {
	await open(page);
	await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	const later = onDisk(server);
	// The clone becomes a snapshot before the autosave, as from another window.
	await editor(page).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("% typed as it moved\n");
	git(server.paper, "switch", "--quiet", "--detach", "HEAD~1");
	const first = onDisk(server);
	const refused = page
		.getByRole("alert")
		.filter({ hasText: "earlier version" });
	await expect(refused.getByLabel("Your unsaved text")).toHaveValue(
		/^% typed as it moved\n/,
	);
	await expect(readOnly(page)).toBeVisible();

	await returnTo(page, "main");
	await expect(versionDialog(page)).toBeHidden();
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	await expect(refused.getByLabel("Your unsaved text")).toHaveValue(
		/^% typed as it moved\n/,
	);
	// Saved nowhere: not on the snapshot, not on the branch, even after more typing.
	expect(first).not.toContain("% typed as it moved");
	await page.keyboard.type("x");
	await page.waitForTimeout(1500);
	expect(onDisk(server)).toBe(later);
	expect(git(server.paper, "status", "--porcelain")).toBe("");

	await refused.getByRole("button", { name: "Reload" }).click();
	await expect(refused).toBeHidden();
	await expect
		.poll(() => editorText(page))
		.not.toContain("% typed as it moved");
	await typeAtStart(page, "% editable again\n");
	expect(onDisk(server)).toContain("% editable again");
});

test("Branch from an earlier version: Start a branch here asks for a name, the branch starts at that commit, and the editor accepts edits", async ({
	page,
	server,
}) => {
	await viewFirst(page);
	const first = git(server.paper, "rev-parse", "HEAD");
	await readOnly(page).click();
	const dialog = versionDialog(page);
	await dialog.getByRole("button", { name: "Start a branch here" }).click();
	await dialog.getByLabel("Branch name").fill("from-first");
	await dialog.getByRole("button", { name: "Create branch" }).click();
	await expect(dialog).toBeHidden();
	await expect(topbar(page).getByText("on branch from-first")).toBeVisible();
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(first);
	await typeAtStart(page, "% on the new branch\n");
	expect(onDisk(server)).toContain("% on the new branch");
});

test("Branch age does not lock editing: an old branch, and a branch Get latest advanced, stay editable", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	// "old" holds only the first commit, older than and behind main.
	git(server.paper, "branch", "old");
	const p = await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	await switchTo(page, "old");
	await expect(topbar(page).getByText("on branch old")).toBeVisible();
	await expect(readOnly(page)).toHaveCount(0);
	await typeAtStart(page, "% on an old branch\n");
	expect(onDisk(server)).toContain("% on an old branch");
	await commit(page, "Old branch note");

	await switchTo(page, "main");
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	await p.getByRole("button", { name: "Send", exact: true }).click();
	await expect(p.getByRole("status")).toContainText("Sent");
	const other = coauthor(github);
	other.push("Their reference", "Small steps", "Smaller steps", "refs.bib");
	other.remove();
	await p.getByRole("button", { name: "Get latest" }).click();
	await expect(p.getByRole("status")).toContainText("up to date");
	await expect(readOnly(page)).toHaveCount(0);
	await typeAtStart(page, "% after Get latest\n");
	expect(onDisk(server)).toContain("% after Get latest");
});

test("Encoding read-only reason: a file that is not UTF-8 says so beside its name and offers no branch", async ({
	page,
	server,
}) => {
	await open(page);
	writeFileSync(
		join(server.paper, "latin1.tex"),
		Buffer.from("Caf\xe9 au lait\n", "latin1"),
	);
	await openFromTree(page, "latin1.tex");
	await expect(openFileName(page)).toHaveText("latin1.tex");
	await expect(saveStatus(page)).toContainText("not UTF-8");
	const pane = page.getByRole("region", { name: "Editor" });
	await expect(pane.getByRole("button", { name: /branch/i })).toHaveCount(0);
	await expect(readOnly(page)).toHaveCount(0);
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
});

test("PDF from another version: a snapshot builds, and after Return in the header dialog that PDF is out of date", async ({
	page,
	server,
}) => {
	test.setTimeout(120_000);
	await viewFirst(page);
	await expect.poll(() => editorText(page)).toContain(TITLE);

	// The snapshot builds.
	await page.getByRole("button", { name: "Build PDF" }).click();
	await expect(page.locator('[data-page="1"] canvas')).toHaveCount(1, {
		timeout: 60_000,
	});
	await expect(page.getByText("The PDF is out of date")).toHaveCount(0);

	// Back on the branch, that PDF is out of date and the editor takes edits.
	await returnTo(page, "main");
	await expect(readOnly(page)).toHaveCount(0);
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	await expect.poll(() => editorText(page)).toContain("A Later Title");
	await expect(page.getByText("The PDF is out of date")).toBeVisible();
	await typeAtStart(page, "% editable again\n");
	expect(onDisk(server)).toContain("% editable again");
});

/** Commits a later title, leaves an uncommitted edit, and chooses View
 * this version on the first commit. */
async function viewWithChanges(page: Page) {
	await open(page);
	const p = await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	await typeAtStart(page, "% unfinished\n");
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "View this version" }).click();
}

test("View with uncommitted changes: the prompt lists them, and the checkout stays until Commit succeeds", async ({
	page,
	server,
}) => {
	await viewWithChanges(page);
	const head = git(server.paper, "rev-parse", "HEAD");
	const dialog = prompt(page, /View the version/);
	await expect(dialog).toContainText("Initial manuscript");
	await expect(
		dialog.getByRole("list", { name: "Changed files" }).getByRole("listitem"),
	).toHaveText([/main\.tex/]);
	for (const name of ["Commit", "Discard…", "Cancel"])
		await expect(
			dialog.getByRole("button", { name, exact: true }),
		).toBeVisible();

	// A description is required; without one nothing happens.
	await dialog.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(dialog).toBeVisible();
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(head);
	await expect(readOnly(page)).toHaveCount(0);

	await dialog.getByLabel("Describe your changes").fill("Unfinished note");
	await dialog.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(readOnly(page)).toBeVisible();
	expect(git(server.paper, "branch", "--show-current")).toBe("");
	expect(git(server.paper, "log", "-1", "--format=%s", "main")).toBe(
		"Unfinished note",
	);
});

test("Cancel: nothing is committed, discarded, or moved", async ({
	page,
	server,
}) => {
	await viewWithChanges(page);
	const head = git(server.paper, "rev-parse", "HEAD");
	const dialog = prompt(page, /View the version/);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(head);
	expect(git(server.paper, "status", "--porcelain")).toBe("M main.tex");
	expect(onDisk(server)).toMatch(/^% unfinished\n/);
	await expect(readOnly(page)).toHaveCount(0);
});

test("Get latest with uncommitted changes: the prompt shows, and the merge waits for the confirmed discard", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	const other = coauthor(github);
	const theirs = other.push(
		"Their reference",
		"Small steps",
		"Smaller steps",
		"refs.bib",
	);
	other.remove();
	const head = git(server.paper, "rev-parse", "HEAD");
	await typeAtStart(page, "% unfinished\n");
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Get latest" }).click();

	const dialog = prompt(page, "Get latest for branch main");
	await expect(
		dialog.getByRole("list", { name: "Changed files" }),
	).toContainText("main.tex");
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(head);
	expect(onDisk(server, "refs.bib")).toContain("Small steps");

	await dialog.getByRole("button", { name: "Discard…" }).click();
	await page
		.getByRole("dialog", { name: /Discard/ })
		.getByRole("button", { name: "Discard these changes" })
		.click();
	await expect(dialog).toBeHidden();
	await expect(p.getByRole("status")).toContainText("up to date");
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(theirs);
	expect(onDisk(server, "refs.bib")).toContain("Smaller steps");
	expect(onDisk(server)).not.toContain("% unfinished");
});

test("Move fails after a commit: the prompt says the work was committed and Get latest did not happen, and does not retry", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	await typeAtStart(page, "% unfinished\n");
	const p = await openPanel(page);
	let pulls = 0;
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().endsWith("/git/pull")) pulls++;
	});
	await p.getByRole("button", { name: "Get latest" }).click();
	const dialog = prompt(page, "Get latest for branch main");
	await expect(dialog).toBeVisible();

	// GitHub goes away between the prompt and the commit.
	renameSync(bare(github), `${bare(github)}.away`);
	await dialog.getByLabel("Describe your changes").fill("Unfinished note");
	await dialog.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("committed");
	await expect(dialog.getByRole("alert")).toContainText("did not happen");
	await expect(dialog.getByRole("alert")).toContainText(
		"Could not reach GitHub",
	);
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	expect(git(server.paper, "log", "-1", "--format=%s")).toBe("Unfinished note");
	expect(git(server.paper, "status", "--porcelain")).toBe("");
	await page.waitForTimeout(500);
	expect(pulls).toBe(2);

	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
	expect(pulls).toBe(2);
});

test("Unfinished merge: a move is refused without a prompt until the merge is finished or undone", async ({
	page,
	github,
	server,
}) => {
	await conflict(page, github);
	const head = git(server.paper, "rev-parse", "HEAD");
	const p = panel(page);
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "View this version" }).click();
	await expect(
		p.getByRole("alert").filter({ hasText: "Finish or undo the merge first" }),
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(head);
	git(server.paper, "rev-parse", "MERGE_HEAD");
	expect(onDisk(server)).toContain("<<<<<<<");
});

test("Commit link after newer pushes: the commit opens as a read-only snapshot, the header explains why and offers the way to edit, and a branch from it can be committed", async ({
	page,
	github,
	server,
}) => {
	// The author shares the tip of main, then pushes again to main.
	const first = git(bare(github), "rev-parse", "main");
	const other = coauthor(github);
	other.push("Later", TITLE, "\\title{Later}");
	other.remove();

	await open(page, `${PAPER.url}/commit/${first}`);
	await expect(readOnly(page)).toBeVisible();
	await typingIsRefused(page, server);

	await readOnly(page).click();
	const dialog = versionDialog(page);
	await expect(dialog).toContainText("Initial manuscript");
	await expect(dialog).toContainText("cannot be changed");
	await expect(
		dialog.getByRole("button", { name: "Return to main" }),
	).toBeVisible();
	await dialog.getByRole("button", { name: "Start a branch here" }).click();
	await dialog.getByLabel("Branch name").fill("from-snapshot");
	await dialog.getByRole("button", { name: "Create branch" }).click();
	await expect(topbar(page).getByText("on branch from-snapshot")).toBeVisible();
	await expect(readOnly(page)).toHaveCount(0);
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(first);

	await typeAtStart(page, "% on a branch from the snapshot\n");
	await openPanel(page);
	await commit(page, "Note on the snapshot");
	expect(git(server.paper, "log", "-1", "--format=%s", "from-snapshot")).toBe(
		"Note on the snapshot",
	);
});

test("Leave with pending text: going Home saves the text on its branch first", async ({
	page,
	server,
}) => {
	await open(page);
	await editor(page).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type("% typed just before leaving\n");
	// Well inside the 1 s autosave delay.
	await topbar(page).getByRole("link", { name: "Revisions" }).click();
	await expect(page.getByLabel("GitHub link")).toBeVisible();
	expect(onDisk(server)).toMatch(/^% typed just before leaving\n/);
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
});

test.describe("slow switch", () => {
	// The server's git sleeps 2 s before every switch.
	const shim = mkdtempSync(join(tmpdir(), "revisions-slow-git-"));
	const real = execFileSync("sh", ["-c", "command -v git"], {
		encoding: "utf8",
	}).trim();
	writeFileSync(
		join(shim, "git"),
		`#!/bin/sh\n[ "$1" = switch ] && sleep 2\nexec '${real}' "$@"\n`,
		{ mode: 0o755 },
	);
	test.use({ serverEnv: { PATH: `${shim}:${process.env.PATH}` } });
	test.afterAll(() => rmSync(shim, { recursive: true, force: true }));

	test("Escape while working: the Branches dialog stays open until its switch finishes", async ({
		page,
		server,
	}) => {
		await open(page);
		git(server.paper, "branch", "draft");
		const p = await openPanel(page);
		await p.getByRole("button", { name: "Branch…" }).click();
		const dialog = page.getByRole("dialog", { name: "Branches" });
		const draft = dialog.getByRole("button", { name: "Switch to draft" });
		await draft.click();
		await expect(draft).toBeDisabled();

		// Twice: Chrome may close a dialog on a repeated Escape even after refusing one.
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		await expect(dialog).toBeVisible();
		expect(git(server.paper, "branch", "--show-current")).toBe("main");

		await expect(dialog).toBeHidden({ timeout: 10_000 });
		await expect(topbar(page).getByText("on branch draft")).toBeVisible();
		expect(git(server.paper, "branch", "--show-current")).toBe("draft");
	});
});

const refsOf = (dir: string) =>
	git(dir, "for-each-ref", "--format=%(objectname) %(refname)");
const hasBranch = (dir: string, name: string) =>
	git(dir, "branch", "--list", name) !== "";

/** Adds an empty commit on branch `name` of `dir` without checking it out. */
function commitOn(dir: string, name: string, subject: string) {
	const tip = git(dir, "rev-parse", name);
	const next = git(
		dir,
		"commit-tree",
		"-p",
		tip,
		"-m",
		subject,
		`${tip}^{tree}`,
	);
	git(dir, "update-ref", `refs/heads/${name}`, next);
	return next;
}

/**
 * On the page's clone: commits a new file on a new branch `name`, sends it,
 * and opens a pull request for it through the fake. Leaves the clone on that
 * branch and returns the pull request's number.
 */
async function propose(server: Server, github: Fake, name: string) {
	git(server.paper, "switch", "--quiet", "-c", name);
	writeFileSync(join(server.paper, `${name}.tex`), `% on ${name}\n`);
	git(server.paper, "add", "-A");
	git(server.paper, "commit", "--quiet", "-m", `Work on ${name}`);
	git(server.paper, "push", "--quiet", "-u", "origin", name);
	const res = await fetch(`${github.apiUrl}/repos/ada/paper/pulls`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${github.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			title: `Work on ${name}`,
			head: name,
			base: "main",
		}),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { number: number }).number;
}

/** The author squash-merges the pull request for `name` and deletes its branch on GitHub. */
function squashMerge(github: Fake, name: string) {
	const author = coauthor(github);
	author.git("merge", "--quiet", "--squash", `origin/${name}`);
	author.git("commit", "--quiet", "-m", `Squashed ${name}`);
	author.git("push", "--quiet", "origin", "main");
	author.git("push", "--quiet", "origin", "--delete", name);
	author.remove();
}

/** Opens the deletion confirmation for `name` from the Branches dialog. */
async function previewDeletion(page: Page, name: string) {
	await panel(page).getByRole("button", { name: "Branch…" }).click();
	await page
		.getByRole("dialog", { name: "Branches" })
		.getByRole("button", { name: `Delete ${name}…` })
		.click();
	return page.getByRole("dialog", { name: `Delete branch ${name}?` });
}

const finished = (page: Page) =>
	panel(page).getByRole("list", { name: "Finished branches" });

test("Delete a branch with unique commits", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	git(server.paper, "branch", "side");
	commitOn(server.paper, "side", "A note only on side");
	const before = refsOf(bare(github));
	await openPanel(page);

	const dialog = await previewDeletion(page, "side");
	const lost = dialog.getByRole("list", { name: "Commits that will be lost" });
	await expect(lost).toContainText("A note only on side");
	await expect(dialog).toContainText("lost from this computer");
	await expect(dialog).toContainText("GitHub is not changed");
	expect(hasBranch(server.paper, "side")).toBe(true);
	await dialog.getByRole("button", { name: "Delete branch" }).click();

	await expect(dialog).toBeHidden();
	await expect(panel(page).getByRole("status")).toContainText(
		"Branch side was deleted from this computer",
	);
	expect(hasBranch(server.paper, "side")).toBe(false);
	expect(hasBranch(server.paper, "main")).toBe(true);
	expect(refsOf(bare(github))).toBe(before);
});

test("Delete a squash-merged branch", async ({ page, github, server }) => {
	await open(page);
	await propose(server, github, "feature");
	git(server.paper, "switch", "--quiet", "main");
	squashMerge(github, "feature");
	await openPanel(page);
	// The check on opening the panel brings the pull request's reference.
	await expect(finished(page)).toContainText("feature");

	const dialog = await previewDeletion(page, "feature");
	await expect(dialog).toContainText(
		"Every commit on feature is kept elsewhere",
	);
	await expect(
		dialog.getByRole("list", { name: "Commits that will be lost" }),
	).toHaveCount(0);
	await dialog.getByRole("button", { name: "Delete branch" }).click();
	await expect(dialog).toBeHidden();
	expect(hasBranch(server.paper, "feature")).toBe(false);
});

test("Changed deletion preview", async ({ page, server }) => {
	await open(page);
	git(server.paper, "branch", "side");
	commitOn(server.paper, "side", "First note");
	await openPanel(page);
	const dialog = await previewDeletion(page, "side");
	const lost = dialog.getByRole("list", { name: "Commits that will be lost" });
	await expect(lost.getByRole("listitem")).toHaveCount(1);

	const late = commitOn(server.paper, "side", "A late note");
	await dialog.getByRole("button", { name: "Delete branch" }).click();
	await expect(dialog.getByRole("alert")).toContainText("nothing was deleted");
	await expect(lost.getByRole("listitem")).toHaveCount(2);
	await expect(lost).toContainText("A late note");
	expect(git(server.paper, "rev-parse", "side")).toBe(late);
});

test("Finished after a squash merge", async ({ page, github, server }) => {
	await open(page);
	const number = await propose(server, github, "feature");
	git(server.paper, "switch", "--quiet", "main");
	squashMerge(github, "feature");
	const before = refsOf(bare(github));

	await openPanel(page);
	const item = finished(page)
		.getByRole("listitem")
		.filter({ hasText: "feature" });
	await expect(item).toContainText("kept on GitHub");
	await expect(item).toContainText(
		`kept on GitHub, in pull request #${number}`,
	);
	// Listed, not removed: removal waits for the click.
	await page.waitForTimeout(500);
	expect(hasBranch(server.paper, "feature")).toBe(true);

	await item.getByRole("button", { name: "Remove branch feature" }).click();
	await expect(finished(page)).toHaveCount(0);
	expect(hasBranch(server.paper, "feature")).toBe(false);
	expect(refsOf(bare(github))).toBe(before);
});

test("Unsent work keeps a branch", async ({ page, github, server }) => {
	await open(page);
	await propose(server, github, "feature");
	git(server.paper, "switch", "--quiet", "main");
	await propose(server, github, "done");
	git(server.paper, "switch", "--quiet", "main");
	squashMerge(github, "feature");
	squashMerge(github, "done");
	commitOn(server.paper, "feature", "Never sent");

	await openPanel(page);
	// After the check, the branch with nothing unsent is listed; feature is not.
	await expect(finished(page).getByRole("listitem")).toHaveCount(1);
	await expect(finished(page)).toContainText("done");
	await expect(finished(page)).not.toContainText("feature");
	expect(hasBranch(server.paper, "feature")).toBe(true);
});

test("Finished current branch", async ({ page, github, server }) => {
	await open(page);
	await propose(server, github, "feature");
	squashMerge(github, "feature");
	await expect(topbar(page).getByText("on branch feature")).toBeVisible();

	await openPanel(page);
	const item = finished(page)
		.getByRole("listitem")
		.filter({ hasText: "feature" });
	await item.getByRole("button", { name: "Remove branch feature" }).click();
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	await expect(panel(page).getByRole("status")).toContainText(
		"You are now on branch main",
	);
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	expect(hasBranch(server.paper, "feature")).toBe(false);
});
