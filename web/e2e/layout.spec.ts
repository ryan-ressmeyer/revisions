import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, openFromTree, openPaper, test } from "./fixtures";

const tree = (page: Page) => page.getByRole("tree", { name: "Files" });
const item = (page: Page, path: string) =>
	tree(page).locator(`[data-path="${path}"]`);
const editorPane = (page: Page) => page.getByRole("region", { name: "Editor" });
const pdfPane = (page: Page) => page.getByRole("region", { name: "PDF" });

test("File tree: folders first, the main document marked, text opens, images preview, others explain", async ({
	page,
	server,
}) => {
	await openPaper(page);
	const top = tree(page).locator('[role="treeitem"][aria-level="1"]');
	await expect(top).toHaveCount(6);
	expect(
		await top.evaluateAll((els) => els.map((e) => e.dataset.path)),
	).toEqual([
		"figures",
		"sections",
		"main.tex",
		"refs.bib",
		"stats.tex",
		"supplement.tex",
	]);
	await expect(item(page, "main.tex")).toHaveAttribute("aria-selected", "true");
	await expect(item(page, "main.tex")).toContainText("main document");

	await openFromTree(page, "sections/methods.tex");
	await expect(item(page, "sections/methods.tex")).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(editorPane(page).getByText("Methods").first()).toBeVisible();

	// Keyboard: Home, ArrowRight opens a folder, ArrowDown, Enter.
	await item(page, "sections/methods.tex").focus();
	await page.keyboard.press("Home");
	await expect(item(page, "figures")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(item(page, "figures")).toHaveAttribute("aria-expanded", "true");
	await page.keyboard.press("ArrowDown");
	await expect(item(page, "figures/trace.png")).toBeFocused();
	await page.keyboard.press("Enter");
	const preview = editorPane(page).getByRole("img", {
		name: "figures/trace.png",
	});
	await expect
		.poll(() => preview.evaluate((el) => (el as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	await page.keyboard.press("ArrowLeft");
	await expect(item(page, "figures")).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(item(page, "figures")).toHaveAttribute("aria-expanded", "false");

	// Back to a text file from the preview.
	await openFromTree(page, "main.tex");
	await expect(preview).toHaveCount(0);
	await expect(editorPane(page).getByText("Introduction")).toBeVisible();

	writeFileSync(join(server.paper, "data.bin"), "\u0000\u0001");
	await page.reload();
	await item(page, "data.bin").click();
	await expect(
		page.getByText("data.bin cannot be opened in Revisions"),
	).toBeVisible();
	await expect(item(page, "main.tex")).toHaveAttribute("aria-selected", "true");

	// The sidebar folds away, and stays folded after a reload.
	const files = page.getByRole("button", { name: "Files" });
	await expect(files).toHaveAttribute("aria-expanded", "true");
	await files.click();
	await expect(tree(page)).toBeHidden();
	await page.reload();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	await expect(tree(page)).toBeHidden();
	await files.click();
	await expect(tree(page)).toBeVisible();
});

test("Panes: the editor or the PDF can be hidden, the choice is remembered, and Changes & history still opens", async ({
	page,
}) => {
	await openPaper(page);
	const show = (name: string) =>
		page.getByRole("group", { name: "Show" }).getByRole("button", { name });
	await expect(show("Both")).toHaveAttribute("aria-pressed", "true");

	await show("Editor").click();
	await expect(pdfPane(page)).toBeHidden();
	await expect(editorPane(page)).toBeVisible();
	await page.reload();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
	await expect(pdfPane(page)).toBeHidden();
	await expect(show("Editor")).toHaveAttribute("aria-pressed", "true");

	await page.getByRole("button", { name: "Changes & history" }).click();
	const panel = page.getByRole("region", { name: "Changes & history" });
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("button", { name: /Get latest/ })).toBeVisible();
	// Escape closes the panel when no dialog is open.
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Changes & history" }),
	).toBeFocused();

	await show("PDF").click();
	await expect(editorPane(page)).toBeHidden();
	await expect(pdfPane(page)).toBeVisible();
	await show("Both").click();
	await expect(editorPane(page)).toBeVisible();
	await expect(pdfPane(page)).toBeVisible();
});

test("File tree: files added or removed on disk appear and go without a reload", async ({
	page,
	server,
}) => {
	await openPaper(page);
	await expect(item(page, "main.tex")).toBeVisible();
	writeFileSync(join(server.paper, "notes.tex"), "Added outside Revisions.\n");
	await expect(item(page, "notes.tex")).toBeVisible();
	rmSync(join(server.paper, "notes.tex"));
	await expect(item(page, "notes.tex")).toHaveCount(0);
});

test("File name: a name that starts with punctuation reads in order", async ({
	page,
	server,
}) => {
	await openPaper(page);
	writeFileSync(join(server.paper, "!notes.tex"), "Notes.\n");
	await openFromTree(page, "!notes.tex");
	const name = editorPane(page).locator(".file-name");
	await expect(name).toContainText("!notes.tex");
	// The bang must be drawn before the n, not moved to the end.
	const [bang, n] = await name.evaluate((el) => {
		const text = el.querySelector("bdi")?.firstChild ?? el.firstChild;
		const left = (i: number) => {
			const r = document.createRange();
			r.setStart(text as Node, i);
			r.setEnd(text as Node, i + 1);
			return r.getBoundingClientRect().left;
		};
		return [left(0), left(1)];
	});
	expect(bang).toBeLessThan(n);
});
