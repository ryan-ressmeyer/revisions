import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("Dirty clone: refuses to switch, explains why, and offers the copy as it is", async ({
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

	await page.goto("/");
	await page.getByLabel("GitHub link").fill(`${PAPER.url}/tree/other`);
	await page.getByRole("button", { name: "Open" }).click();
	const alert = page.getByRole("alert");
	await expect(alert).toContainText("changes that are not yet saved to Git");
	await expect(alert).toContainText("commit them or discard them");
	await expect(alert.getByRole("listitem")).toHaveText(["main.tex (changed)"]);

	await alert.getByRole("button", { name: "Open this copy as it is" }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	expect(await editorText(page)).toMatch(/^% local note\n/);
	expect(readFileSync(main, "utf8")).toMatch(/^% local note\n/);
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
