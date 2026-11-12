import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
	test as base,
	editorText,
	expect,
	type Fake,
	openFileName,
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

test("Branch: switching is refused while there are uncommitted changes", async ({
	page,
	github,
	server,
}) => {
	await open(page);
	const other = coauthor(github);
	other.git("switch", "--quiet", "-c", "draft");
	other.push("Draft title", TITLE, "\\title{Draft Title}");
	other.remove();

	await typeAtStart(page, "% unfinished\n");
	const p = await openPanel(page);
	await p.getByRole("button", { name: "Branch…" }).click();
	const dialog = page.getByRole("dialog", { name: "Branches" });
	const draft = dialog.getByRole("listitem").filter({ hasText: "draft" });
	await draft.getByRole("button", { name: "Switch" }).click();
	await expect(dialog.getByRole("alert")).toContainText(/commit or discard/i);
	await expect(dialog.getByRole("alert")).toContainText("main.tex");
	expect(git(server.paper, "branch", "--show-current")).toBe("main");

	git(server.paper, "checkout", "--", "main.tex");
	await expect(editor(page)).not.toContainText("% unfinished");
	await draft.getByRole("button", { name: "Switch" }).click();
	await expect(dialog).toBeHidden();
	await expect(topbar(page).getByText("on branch draft")).toBeVisible();
	expect(await editorText(page)).toContain("\\title{Draft Title}");
});

const banner = (page: Page) =>
	page.getByRole("region", { name: "Earlier version" });

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

test("View this version: an earlier version is read-only, builds, and the banner goes back to the branch", async ({
	page,
	server,
}) => {
	test.setTimeout(120_000);
	await open(page);
	const p = await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	await expect(banner(page)).toHaveCount(0);

	// Selecting an earlier commit offers to view it; the latest one does not.
	await expect(
		p.getByRole("button", { name: "View this version" }),
	).toHaveCount(0);
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "View this version" }).click();
	await expect(banner(page)).toContainText("Initial manuscript");
	await expect(banner(page)).toContainText("cannot be changed");
	await expect.poll(() => editorText(page)).toContain(TITLE);
	expect(git(server.paper, "branch", "--show-current")).toBe("");
	await typingIsRefused(page, server);

	// The snapshot builds.
	await page.getByRole("button", { name: "Build PDF" }).click();
	await expect(page.locator('[data-page="1"] canvas')).toHaveCount(1, {
		timeout: 60_000,
	});
	await expect(page.getByText("The PDF is out of date")).toHaveCount(0);

	// Back on the branch, that PDF is out of date and the editor takes edits.
	await banner(page).getByRole("button", { name: "Back to main" }).click();
	await expect(banner(page)).toHaveCount(0);
	await expect(topbar(page).getByText("on branch main")).toBeVisible();
	await expect.poll(() => editorText(page)).toContain("A Later Title");
	await expect(page.getByText("The PDF is out of date")).toBeVisible();
	await typeAtStart(page, "% editable again\n");
	expect(onDisk(server)).toContain("% editable again");
});

test("View this version: refused while there are uncommitted changes", async ({
	page,
	server,
}) => {
	await open(page);
	const p = await openPanel(page);
	await retitle(page, "A Later Title");
	await commit(page, "Later title");
	await typeAtStart(page, "% unfinished\n");
	await history(page)
		.getByRole("button", { name: /Initial manuscript/ })
		.click();
	await p.getByRole("button", { name: "View this version" }).click();
	await expect(p.getByRole("alert")).toContainText(/commit or discard/i);
	await expect(p.getByRole("alert")).toContainText("main.tex");
	expect(git(server.paper, "branch", "--show-current")).toBe("main");
	await expect(banner(page)).toHaveCount(0);
});

test("Snapshot: a commit link opens a read-only snapshot, and a branch from it can be edited and committed", async ({
	page,
	github,
	server,
}) => {
	const first = git(bare(github), "rev-parse", "main");
	const other = coauthor(github);
	other.push("Later", TITLE, "\\title{Later}");
	other.remove();

	await open(page, `${PAPER.url}/commit/${first}`);
	await expect(
		topbar(page).getByText(`at version ${first.slice(0, 7)}`),
	).toBeVisible();
	await expect(banner(page)).toContainText("Initial manuscript");
	await expect(
		banner(page).getByRole("button", { name: "Back to main" }),
	).toBeVisible();
	await typingIsRefused(page, server);

	await banner(page)
		.getByRole("button", { name: "Start a branch from this version" })
		.click();
	await banner(page).getByLabel("Branch name").fill("from-snapshot");
	await banner(page).getByRole("button", { name: "Create branch" }).click();
	await expect(topbar(page).getByText("on branch from-snapshot")).toBeVisible();
	await expect(banner(page)).toHaveCount(0);
	expect(git(server.paper, "rev-parse", "HEAD")).toBe(first);

	await typeAtStart(page, "% on a branch from the snapshot\n");
	await openPanel(page);
	await commit(page, "Note on the snapshot");
	expect(git(server.paper, "log", "-1", "--format=%s", "from-snapshot")).toBe(
		"Note on the snapshot",
	);
});
