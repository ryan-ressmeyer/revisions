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

test("Commit: an edit becomes the newest commit in the graph", async ({
	page,
	server,
}) => {
	await open(page);
	await expect(
		page.getByRole("button", { name: "Changes & history" }),
	).toBeVisible();
	await typeAtStart(page, "% a note for the panel\n");
	await expect(
		page.getByRole("button", { name: /Changes & history.*uncommitted/ }),
	).toBeVisible();

	const p = await openPanel(page);
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	await expect(
		p.getByRole("listitem").filter({ hasText: "main.tex" }).first(),
	).toContainText("changed");
	await expect(p.locator(".diff-add")).toContainText("% a note for the panel");

	await commit(page, "Add a note");
	expect(git(server.paper, "log", "-1", "--format=%s")).toBe("Add a note");
	await expect(
		page.getByRole("button", { name: "Changes & history", exact: true }),
	).toBeVisible();
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

test("Open a pull request: a branch is sent and its pull request shows in the graph", async ({
	page,
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

	// Not sent yet: the pull request asks for a Send first.
	await p.getByRole("button", { name: "Pull request…" }).click();
	const dialog = page.getByRole("dialog", { name: "Open a pull request" });
	await dialog.getByLabel("Title").fill("A better title");
	await dialog.getByLabel("Description").fill("Shorter and clearer.");
	await dialog.getByRole("button", { name: "Open pull request" }).click();
	await expect(dialog.getByRole("alert")).toContainText("Send");
	await dialog.getByRole("button", { name: "Send now" }).click();
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
});

test.describe("read-only account", () => {
	test.use({ fakeArgs: ["-push=false"] });

	test("Read-only collaborator: no Send, Force-push, or pull request, and a reason", async ({
		page,
	}) => {
		await open(page);
		await typeAtStart(page, "% local only\n");
		const p = await openPanel(page);
		await expect(p).toContainText("can read this manuscript but not change it");
		await expect(p.getByRole("button", { name: "Get latest" })).toBeVisible();
		await expect(p.getByRole("button", { name: "Send" })).toHaveCount(0);
		await expect(p.getByRole("button", { name: /Force-push/ })).toHaveCount(0);
		await expect(p.getByRole("button", { name: /pull request/i })).toHaveCount(
			0,
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
