import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
	expect,
	openFileName,
	openFromTree,
	openPaper,
	PAPER,
	type Server,
	showSource,
	startServer,
	test,
} from "./fixtures";

/** Calls the server's API from the page, with the page's token. */
function api<T>(page: Page, path: string): Promise<T> {
	return page.evaluate(async (path) => {
		const token =
			document.querySelector<HTMLMetaElement>('meta[name="revisions-token"]')
				?.content ?? "";
		const response = await fetch(path, {
			headers: { "X-Revisions-Token": token },
		});
		return response.json();
	}, path);
}

interface Box {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Points at the middle of the SyncTeX box of a source line, on screen. */
async function spotOf(page: Page, path: string, line: number) {
	const box = await api<Box>(
		page,
		`/api/repos/${PAPER.id}/synctex/forward?path=${path}&line=${line}`,
	);
	const pageEl = page.getByRole("img", { name: `Page ${box.page}` });
	await pageEl.scrollIntoViewIfNeeded();
	const rect = await pageEl.boundingBox();
	if (!rect) throw new Error("page not on screen");
	const scale = rect.width / 612; // US letter, the article class default
	return {
		x: rect.x + (box.x + box.width / 2) * scale,
		y: rect.y + (box.y + box.height / 2) * scale,
	};
}

/** The cursor's source line, read from the gutter in Source mode, where
 * every source line has its own row (Rich text joins soft line breaks). */
const cursorLine = async (page: Page) => {
	await showSource(page);
	return page.locator(".cm-activeLineGutter").textContent();
};

const source = (page: Page) => page.getByRole("textbox", { name: "Source" });

// One clone and one successful build, shared in order: each build takes
// several seconds.
test.describe("with a built PDF", () => {
	test.describe.configure({ mode: "serial", timeout: 90_000 });
	let server: Server;
	let page: Page;

	test.beforeAll(async ({ browser, fake }) => {
		server = await startServer(fake);
		page = await browser.newPage({ baseURL: server.url });
		await openPaper(page);
	});
	test.afterAll(async () => {
		await page.close();
		await server.stop();
	});

	test("Build: the button builds the PDF and shows it beside the editor", async () => {
		await expect(page.getByText("No PDF yet")).toBeVisible();
		await page.getByRole("button", { name: "Build PDF" }).click();
		await expect(page.getByText("Building the PDF…").first()).toBeVisible();
		await expect(
			page.getByRole("status").filter({ hasText: /Building the PDF… \d+ s/ }),
		).toBeVisible();
		await expect(page.locator('[data-page="1"] canvas')).toHaveCount(1, {
			timeout: 60_000,
		});
		await expect(page.getByRole("img", { name: "Page 2" })).toBeAttached();
	});

	test("Source to PDF: Show in PDF scrolls to the cursor's place and marks it", async () => {
		await source(page).click();
		await page.keyboard.press("Control+f");
		await page.keyboard.type("Our results agree");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Control+j");
		const mark = page.locator(".pdf-highlight");
		await expect(mark).toBeVisible();
		await expect(mark).toBeInViewport();
		const onPage = await mark.evaluate(
			(el) => el.parentElement?.dataset.page ?? "",
		);
		expect(Number(onPage)).toBeGreaterThan(1);
	});

	test("PDF to source: double-click and Ctrl-click open the file at that line", async () => {
		await openFromTree(page, "supplement.tex");
		await expect(openFileName(page)).toHaveText("supplement.tex");

		const abstract = await spotOf(page, "main.tex", 22);
		await page.mouse.dblclick(abstract.x, abstract.y);
		await expect(openFileName(page)).toHaveText("main.tex");

		await expect.poll(() => cursorLine(page).then(Number)).toBeGreaterThan(19);
		expect(Number(await cursorLine(page))).toBeLessThan(27);

		const methods = await spotOf(page, "sections/methods.tex", 7);
		await page.keyboard.down("Control");
		await page.mouse.click(methods.x, methods.y);
		await page.keyboard.up("Control");
		await expect(openFileName(page)).toHaveText("sections/methods.tex");
		await expect.poll(() => cursorLine(page).then(Number)).toBeGreaterThan(5);
		expect(Number(await cursorLine(page))).toBeLessThan(10);
	});

	test("Hidden panes: a click in the PDF and Show in PDF bring back the pane they need", async () => {
		const show = (name: string) =>
			page.getByRole("group", { name: "Show" }).getByRole("button", { name });
		await show("PDF").click();
		await expect(page.getByRole("region", { name: "Editor" })).toBeHidden();
		const abstract = await spotOf(page, "main.tex", 22);
		await page.mouse.dblclick(abstract.x, abstract.y);
		await expect(page.getByRole("region", { name: "Editor" })).toBeVisible();
		await expect(openFileName(page)).toHaveText("main.tex");
		await expect(show("Both")).toHaveAttribute("aria-pressed", "true");

		await show("Editor").click();
		await expect(page.getByRole("region", { name: "PDF" })).toBeHidden();
		await source(page).click();
		await page.keyboard.press("Control+j");
		const mark = page.locator(".pdf-highlight");
		await expect(page.getByRole("region", { name: "PDF" })).toBeVisible();
		await expect(mark).toBeInViewport();
		await expect(show("Both")).toHaveAttribute("aria-pressed", "true");
	});

	test("Edit after build: the PDF is marked out of date and is not rebuilt", async () => {
		await openFromTree(page, "main.tex");
		await source(page).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.type("% a note\n");
		const warning = page.getByText("The PDF is out of date");
		await expect(warning).toBeVisible();
		await expect(page.getByText("Saved", { exact: true })).toBeVisible();
		await page.waitForTimeout(3000);
		await expect(warning).toBeVisible();
		const state = await api<{ build: { state: string; pdfVersion: number } }>(
			page,
			`/api/repos/${PAPER.id}/state`,
		);
		expect(state.build).toMatchObject({ state: "succeeded", pdfVersion: 1 });
	});

	test("Failed build: the last good PDF stays and the error is shown", async () => {
		await source(page).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.type("\\nosuchmacro\n");
		await page.keyboard.press("Control+Enter");

		const problems = page.getByRole("alert").filter({
			hasText: "The PDF could not be built",
		});
		await expect(problems).toBeVisible({ timeout: 60_000 });
		await expect(page.locator('[data-page="1"] canvas')).toHaveCount(1);
		await expect(problems.getByText("Full build log")).toBeVisible();

		await source(page).click();
		await page.keyboard.press("Control+End");
		await problems
			.getByRole("button", {
				name: /main\.tex, line 1\b.*Undefined control sequence/,
			})
			.click();
		await expect.poll(() => cursorLine(page)).toBe("1");
	});

	test("Build log: shows the log of the build whose PDF is on screen, after a failed build", async () => {
		await page.getByRole("button", { name: "Build log" }).click();
		const dialog = page.getByRole("dialog", {
			name: "Log of the PDF on screen",
		});
		const log = dialog.getByRole("region", { name: "Build log" });
		await expect(log).toContainText("Output written on");
		await expect(log).not.toContainText("nosuchmacro");
		await page
			.context()
			.grantPermissions(["clipboard-read", "clipboard-write"]);
		await dialog.getByRole("button", { name: "Copy" }).click();
		await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
			"Output written on",
		);
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
	});
});

test("Comment where a margin note cannot go: the failure says why and opens the comment", async ({
	page,
	server,
}) => {
	test.setTimeout(120_000);
	await openPaper(page);
	const main = join(server.paper, "main.tex");
	const text = readFileSync(main, "utf8")
		.replace(
			"\\begin{document}",
			"\\usepackage{changes}\n\\definechangesauthor{GH}\n\\begin{document}",
		)
		.replace(
			"\\centering\n  \\includegraphics",
			"\\centering\n  \\highlight[id=GH, comment={Check the axis}]{Trace.}\n  \\includegraphics",
		);
	writeFileSync(main, text);
	const line = text.slice(0, text.indexOf("\\highlight")).split("\n").length;

	await page.getByRole("button", { name: "Build PDF" }).click();
	const problems = page.getByRole("alert").filter({
		hasText: "The PDF could not be built",
	});
	await expect(problems).toContainText("Float(s) lost", { timeout: 60_000 });
	await expect(problems).toContainText(
		"A comment sits where LaTeX cannot place a margin note",
	);
	await problems
		.getByRole("button", {
			name: `main.tex, line ${line}: Comment in a figure: “Check the axis”`,
		})
		.click();
	await expect(openFileName(page)).toHaveText("main.tex");
	await expect.poll(() => cursorLine(page)).toBe(String(line));
});

test.describe("without TeX", () => {
	// Git is on PATH; latexmk is not.
	const bin = mkdtempSync(join(tmpdir(), "revisions-notex-"));
	symlinkSync("/usr/bin/git", join(bin, "git"));
	test.use({ serverEnv: { PATH: bin } });

	test("Missing TeX: shows install guidance instead of building", async ({
		page,
	}) => {
		await openPaper(page);
		const pdf = page.getByRole("region", { name: "PDF" });
		await expect(
			pdf.getByRole("heading", { name: "Install LaTeX to build the PDF" }),
		).toBeVisible();
		await expect(pdf.getByRole("link", { name: /TeX Live/ })).toHaveAttribute(
			"href",
			"https://tug.org/texlive/",
		);

		await page.getByRole("button", { name: "Build PDF" }).click();
		await expect(
			pdf.getByRole("heading", { name: /Install LaTeX/ }),
		).toBeVisible();
		await expect(page.getByText("Building the PDF…")).toHaveCount(0);
	});
});
