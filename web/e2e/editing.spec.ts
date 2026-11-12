import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
	editorText,
	expect,
	openFileName,
	openFromTree,
	openPaper,
	showSource,
	test,
} from "./fixtures";

async function typeAtStart(page: Page, text: string) {
	await page.getByRole("textbox", { name: "Source" }).click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.type(text);
}

const saveStatus = (page: Page) =>
	page.getByRole("region", { name: "Editor" }).getByRole("status");

test("Several candidates: opens the first entry file and offers the other", async ({
	page,
}) => {
	await openPaper(page);
	const entry = page.getByLabel("Main document");
	await expect(entry).toHaveValue("main.tex");
	await expect(entry.getByRole("option")).toHaveText([
		"main.tex",
		"supplement.tex",
	]);

	await entry.selectOption("supplement.tex");
	await page.reload();
	await expect(page.getByLabel("Main document")).toHaveValue("supplement.tex");
	await expect(openFileName(page)).toHaveText("supplement.tex");
});

test("Autosave: an edit reaches the file on disk byte for byte", async ({
	page,
	server,
}) => {
	// Line endings on disk are CRLF; the editor works in \n.
	const methods = join(server.paper, "sections/methods.tex");
	await openPaper(page);
	const crlf = readFileSync(methods, "utf8").replace(/\n/g, "\r\n");
	writeFileSync(methods, crlf);
	await openFromTree(page, "sections/methods.tex");
	await showSource(page);
	await expect(page.getByRole("textbox", { name: "Source" })).toContainText(
		"\\section{Methods}",
	);

	await typeAtStart(page, "% checked\n");
	await expect(saveStatus(page)).toHaveText("Saved");
	expect(readFileSync(methods, "utf8")).toBe(`% checked\r\n${crlf}`);
});

test("Clean reload: a change on disk appears in the editor without action", async ({
	page,
	server,
}) => {
	await openPaper(page);
	await showSource(page);
	const main = join(server.paper, "main.tex");
	writeFileSync(main, `% added on disk\n${readFileSync(main, "utf8")}`);
	await expect(
		page.getByRole("textbox", { name: "Source" }).getByText("% added on disk"),
	).toBeVisible();
	await expect(saveStatus(page)).toHaveText("Saved");
});

test("Collision: a stale save shows the rejected text with Copy and Reload", async ({
	page,
	server,
}) => {
	await openPaper(page);
	const main = join(server.paper, "main.tex");
	const original = readFileSync(main, "utf8");
	await typeAtStart(page, "% mine\n");
	writeFileSync(main, `% theirs\n${original}`);

	const alert = page.getByRole("alert");
	await expect(alert).toContainText("Your latest changes were not saved");
	await expect(alert.getByLabel("Your unsaved text")).toHaveValue(/^% mine\n/);
	await expect(alert.getByRole("button", { name: "Copy" })).toBeVisible();
	expect(readFileSync(main, "utf8")).toBe(`% theirs\n${original}`);

	await alert.getByRole("button", { name: "Reload" }).click();
	await expect(alert).toHaveCount(0);
	expect(await editorText(page)).toMatch(/^% theirs\n/);
	await expect(saveStatus(page)).toHaveText("Saved");
});

test("Close with pending edits: the browser warns before the tab closes", async ({
	page,
}) => {
	await openPaper(page);
	// Hold every save so the edit stays pending.
	await page.route("**/file?*", (route) => {
		if (route.request().method() !== "PUT") return route.continue();
	});
	await typeAtStart(page, "% pending\n");
	const dialog = page.waitForEvent("dialog");
	await page.close({ runBeforeUnload: true });
	expect((await dialog).type()).toBe("beforeunload");
	await (await dialog).dismiss();
});

test("Settings persist: the build time limit survives a reload", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByLabel("Author ID")).toHaveValue("GH");
	await page.getByLabel("Build time limit, in seconds").fill("600");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("dialog")).toBeHidden();

	await page.reload();
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByLabel("Build time limit, in seconds")).toHaveValue(
		"600",
	);
});

test("Quit: the last edit is saved, the program stops, and the page says so without errors", async ({
	page,
	server,
}) => {
	await openPaper(page);
	const order: string[] = [];
	page.on("requestfinished", (r) => {
		if (r.method() === "PUT" && r.url().includes("/file?")) order.push("save");
	});
	page.on("request", (r) => {
		if (r.url().endsWith("/api/quit")) order.push("quit");
	});
	await typeAtStart(page, "% last words\n");
	await page.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Quit Revisions" }).click();

	await expect(
		page.getByRole("heading", { name: "Revisions has stopped" }),
	).toBeVisible();
	await expect(page.getByText("You can close this tab.")).toBeVisible();
	await expect(page.getByText(/To start it again/)).toBeVisible();
	expect(order.indexOf("save")).toBeGreaterThanOrEqual(0);
	expect(order.indexOf("save")).toBeLessThan(order.indexOf("quit"));
	expect(
		readFileSync(join(server.paper, "main.tex"), "utf8").startsWith(
			"% last words\n",
		),
	).toBe(true);
	expect(await server.exited).toBe(0);

	// Nothing polls the stopped server, so no errors pile up.
	const after: string[] = [];
	page.on("request", (r) => after.push(r.url()));
	await page.waitForTimeout(3000);
	expect(after).toEqual([]);
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Settings: a failure to load them is shown in the dialog", async ({
	page,
}) => {
	await page.goto("/");
	await page.route("**/api/settings", (route) =>
		route.fulfill({
			status: 500,
			contentType: "application/json",
			body: JSON.stringify({
				error: {
					code: "storage_failed",
					message: "The settings file could not be read.",
				},
			}),
		}),
	);
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
		"The settings file could not be read.",
	);
});

test("Colour scheme: follows the system until chosen, applies at once, and holds before first paint after a reload", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/");
	const theme = () =>
		page.evaluate(() => document.documentElement.dataset.theme);
	const background = () =>
		page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	await expect.poll(theme).toBe("dark");
	expect(await background()).toBe("rgb(24, 25, 27)");

	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByLabel("Appearance")).toHaveValue("system");
	await page.getByLabel("Appearance").selectOption("light");
	await page.getByRole("button", { name: "Save" }).click();
	await expect.poll(theme).toBe("light");
	expect(await background()).toBe("rgb(246, 245, 242)");

	// Reloaded with the app's code held back: the page is already light.
	let release = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/assets/*.js", async (route) => {
		await held;
		await route.continue();
	});
	await page.reload({ waitUntil: "commit" });
	await page.waitForFunction(() => document.body !== null);
	expect(
		await page.evaluate(
			() => document.getElementById("root")?.childElementCount,
		),
	).toBe(0);
	expect(await theme()).toBe("light");
	expect(await background()).toBe("rgb(246, 245, 242)");
	release();

	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByLabel("Appearance")).toHaveValue("light");
	await page.getByLabel("Appearance").selectOption("system");
	await page.getByRole("button", { name: "Save" }).click();
	await expect.poll(theme).toBe("dark");
});
