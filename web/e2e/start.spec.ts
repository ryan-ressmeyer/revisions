import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	editorText,
	expect,
	openFileName,
	openPaper,
	PAPER,
	test,
} from "./fixtures";

test.describe("signed out", () => {
	test.use({ serverEnv: { REVISIONS_GITHUB_TOKEN: "" } });

	test("Device sign-in: shows the one-time code and signs in once GitHub confirms it", async ({
		page,
	}) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Sign in with GitHub" }).click();
		await expect(page.getByText("WDJB-MJHT")).toBeVisible();
		await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Open GitHub/ }),
		).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "Open a manuscript" }),
		).toBeVisible();
	});
});

test("First open: a pasted link opens the entry file in the editor", async ({
	page,
}) => {
	await openPaper(page);
	expect(await editorText(page)).toContain("\\documentclass[11pt]{article}");
	await expect(openFileName(page)).toHaveText("main.tex");

	await page.getByRole("link", { name: "Revisions" }).click();
	await expect(page.getByRole("link", { name: "ada/paper" })).toBeVisible();
});

test("Link a folder: a copy kept elsewhere opens in the editor, and a folder that is not set up says so", async ({
	page,
	fake,
}) => {
	const plain = mkdtempSync(join(tmpdir(), "revisions-plain-"));
	const own = join(mkdtempSync(join(tmpdir(), "revisions-own-")), "paper");
	execFileSync("git", [
		"clone",
		"--quiet",
		`${fake.webUrl}/ada/paper.git`,
		own,
	]);

	await page.goto("/");
	const folder = page.getByLabel("Folder on this computer");
	await folder.fill(plain);
	await page.getByRole("button", { name: "Link" }).click();
	await expect(page.getByRole("alert")).toContainText("not set up correctly");

	await folder.fill(own);
	await page.getByRole("button", { name: "Link" }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	expect(await editorText(page)).toContain("\\documentclass[11pt]{article}");

	await page.getByRole("link", { name: "Revisions" }).click();
	await expect(page.getByRole("link", { name: "ada/paper" })).toBeVisible();
	await expect(page.getByText(own)).toBeVisible();
});

test("Repository menu: copy path, properties, remove a copy with unsaved work, and unlink a folder", async ({
	page,
	server,
	fake,
}) => {
	await openPaper(page);
	writeFileSync(join(server.paper, "main.tex"), "% unsaved note\n");
	const own = join(mkdtempSync(join(tmpdir(), "revisions-own-")), "paper");

	await page.getByRole("link", { name: "Revisions" }).click();
	const menu = () =>
		page.getByRole("button", { name: "Actions for ada/paper" }).click();

	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await menu();
	await page.getByRole("menuitem", { name: "Copy path" }).click();
	await expect(page.getByRole("menuitem", { name: "Copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		server.paper,
	);

	await page.getByRole("menuitem", { name: "Properties…" }).click();
	const properties = page.getByRole("dialog", {
		name: "Properties of ada/paper",
	});
	await expect(properties).toContainText("Copy in the Revisions folder");
	await expect(properties).toContainText(server.paper);
	await expect(properties).toContainText("main");
	await expect(properties).toContainText("1 file with uncommitted changes");
	await properties.getByRole("button", { name: "Close" }).click();

	await menu();
	await page.getByRole("menuitem", { name: "Remove…" }).click();
	const remove = page.getByRole("dialog", {
		name: "Remove ada/paper from this computer?",
	});
	await expect(remove).toContainText(server.paper);
	await expect(
		remove.getByRole("list", { name: "Uncommitted changes that will be lost" }),
	).toContainText("main.tex");
	await remove.getByRole("button", { name: "Delete folder" }).click();
	await expect(
		page.getByText("Manuscripts you open appear here."),
	).toBeVisible();
	expect(existsSync(server.paper)).toBe(false);

	execFileSync("git", [
		"clone",
		"--quiet",
		`${fake.webUrl}/ada/paper.git`,
		own,
	]);
	await page.getByLabel("Folder on this computer").fill(own);
	await page.getByRole("button", { name: "Link" }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	await page.getByRole("link", { name: "Revisions" }).click();
	await menu();
	await page.getByRole("menuitem", { name: "Unlink…" }).click();
	const unlink = page.getByRole("dialog", { name: "Unlink ada/paper?" });
	await expect(unlink).toContainText("stays as it is");
	await unlink.getByRole("button", { name: "Unlink" }).click();
	await expect(
		page.getByText("Manuscripts you open appear here."),
	).toBeVisible();
	expect(existsSync(join(own, "main.tex"))).toBe(true);
});

test("Dirty clone: the move prompt for that clone shows, the copy as it is stays available, and Commit opens the link", async ({
	page,
	server,
	fake,
}) => {
	await openPaper(page);
	const main = join(server.paper, "main.tex");
	writeFileSync(main, `% local note\n${readFileSync(main, "utf8")}`);
	// A second commit on GitHub, on a branch named "other".
	const bare = join(fake.remotes, "ada/paper.git");
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", bare, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Ada",
				GIT_AUTHOR_EMAIL: "ada@example.com",
				GIT_COMMITTER_NAME: "Ada",
				GIT_COMMITTER_EMAIL: "ada@example.com",
			},
		}).trim();
	const sha = git("commit-tree", "main^{tree}", "-p", "main", "-m", "other");
	git("update-ref", "refs/heads/other", sha);

	const link = `${PAPER.url}/tree/other`;
	const clone = (...args: string[]) =>
		execFileSync("git", ["-C", server.paper, ...args], {
			encoding: "utf8",
		}).trim();
	const head = clone("rev-parse", "HEAD");
	const openLink = async () => {
		await page.goto("/");
		await page.getByLabel("GitHub link").fill(link);
		await page.getByRole("button", { name: "Open" }).click();
	};
	const prompt = page.getByRole("dialog", { name: `Open ${link}` });

	await openLink();
	await expect(
		prompt.getByRole("list", { name: "Changed files" }).getByRole("listitem"),
	).toHaveText([/main\.tex/]);
	expect(readFileSync(main, "utf8")).toMatch(/^% local note\n/);
	expect(clone("rev-parse", "HEAD")).toBe(head);
	expect(clone("branch", "--show-current")).toBe("main");

	await prompt.getByRole("button", { name: "Open this copy as it is" }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	expect(await editorText(page)).toMatch(/^% local note\n/);
	expect(readFileSync(main, "utf8")).toMatch(/^% local note\n/);

	// Again, and this time commit: the link then opens.
	await openLink();
	await prompt.getByLabel("Describe your changes").fill("Local note");
	await prompt.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	await expect(page.getByText("on branch other")).toBeVisible();
	expect(clone("log", "-1", "--format=%s", "main")).toBe("Local note");
	expect(clone("branch", "--show-current")).toBe("other");
});

test.describe("without a GitHub client ID", () => {
	test.use({
		serverEnv: { REVISIONS_GITHUB_TOKEN: "", REVISIONS_GITHUB_CLIENT_ID: "" },
	});

	test("Sign-in not configured: says plainly why sign-in cannot start", async ({
		page,
	}) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Sign in with GitHub" }).click();
		await expect(page.getByRole("alert")).toContainText(
			"cannot sign in to GitHub",
		);
	});
});

test.describe("without Git", () => {
	test.use({
		serverEnv: { PATH: mkdtempSync(join(tmpdir(), "revisions-nogit-")) },
	});

	test("Missing Git: shows install guidance for the platform", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(
			page.getByRole("heading", { name: "Install Git to continue" }),
		).toBeVisible();
		await expect(page.getByText("git-scm.com")).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Check again" }),
		).toBeVisible();
		await expect(page.getByLabel("GitHub link")).toHaveCount(0);
	});
});
