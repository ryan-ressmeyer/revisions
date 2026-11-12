import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
	expect,
	openFromTree,
	openPaper,
	type Server,
	showSource,
	test,
} from "./fixtures";

const original = readFileSync(
	join(import.meta.dirname, "../../testdata/manuscript/main.tex"),
	"utf8",
);

/** What ensurePreamble adds for the fake's user, Gale Harper. */
const withPreamble = (text: string) =>
	text.replace(
		"\\begin{document}",
		"\\usepackage{changes}\n\\definechangesauthor[name={Gale Harper}, color=blue]{GH}\n\\begin{document}",
	);

const editor = (page: Page) => page.getByRole("textbox", { name: "Source" });
const review = (page: Page) =>
	page.getByRole("complementary", { name: "Review" });
const onDisk = (server: Server, path = "main.tex") =>
	readFileSync(join(server.paper, path), "utf8");

/** Selects the first match of `text` after the cursor, with the search panel. */
async function select(page: Page, text: string) {
	await editor(page).click();
	await page.keyboard.press("Control+f");
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await page.keyboard.press("Escape");
}

/** The whole document as the clipboard gets it from Select all and Copy. */
async function copyAll(page: Page): Promise<string> {
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await editor(page).click();
	await page.keyboard.press("Control+a");
	await page.keyboard.press("Control+c");
	return page.evaluate(() => navigator.clipboard.readText());
}

/** Replaces main.tex on disk and waits for the editor to load it. */
async function seed(page: Page, server: Server, text: string, shows: string) {
	writeFileSync(join(server.paper, "main.tex"), text);
	await expect(editor(page).getByText(shows).first()).toBeVisible();
}

/** Answers the one-time author dialog with the suggested values. */
async function confirmAuthor(page: Page) {
	const dialog = page.getByRole("dialog", { name: "Who are you?" });
	await expect(dialog.getByLabel("Author ID")).toHaveValue("GH");
	await expect(dialog.getByLabel("Your name")).toHaveValue("Gale Harper");
	await dialog.getByRole("button", { name: "Save" }).click();
	await expect(dialog).toBeHidden();
}

test.describe("rendering", () => {
	test("Unknown macro: shows as raw source that is editable in place", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await expect(editor(page).getByText("Introduction")).toBeVisible();
		await expect(editor(page).getByText("\\section{Introduction}")).toHaveCount(
			0,
		);
		await select(page, "\\vdeg{0.5");
		await expect(editor(page).getByText("\\vdeg{0.5}")).toBeVisible();
		await page.keyboard.press("ArrowRight");
		await page.keyboard.type("0");
		await expect(editor(page).getByText("\\vdeg{0.50}")).toBeVisible();
		await expect
			.poll(() => onDisk(server))
			.toBe(original.replace("\\vdeg{0.5}", "\\vdeg{0.50}"));
	});

	test("Cursor entry: a display equation shows its source while the cursor is in it", async ({
		page,
	}) => {
		await openPaper(page);
		await select(page, "The gain followed");
		const rendered = editor(page)
			.locator(".rich-math.display")
			.filter({ hasText: "50" });
		await expect(rendered.locator(".katex-display")).toBeVisible();
		const source = editor(page).locator(".cm-line", {
			hasText: "g(c) = 1 + g_{\\max}",
		});
		await expect(source).toHaveCount(0);

		await rendered.click();
		await expect(source).toBeVisible();
		await expect(rendered).toHaveCount(0);
		await select(page, "is the contrast at half");
		await expect(source).toHaveCount(0);
		await expect(rendered.locator(".katex-display")).toBeVisible();
	});

	test("Unresolved citation: chips say whether keys resolve, across files and before a build", async ({
		page,
	}) => {
		await openPaper(page);
		await select(page, "reached the opposite");
		await expect(
			editor(page).getByLabel("Unresolved citation: missing2019"),
		).toBeVisible();
		await expect(
			editor(page).getByLabel("Citation: rolfs2009").first(),
		).toBeVisible();
		await select(page, "not written yet");
		await expect(
			editor(page).getByLabel("Unresolved reference: sec:missing"),
		).toBeVisible();
		await expect(editor(page).getByLabel("Reference: tab:gain")).toBeVisible();

		await openFromTree(page, "sections/methods.tex");
		await expect(
			editor(page).getByLabel("Citation: engbert2003"),
		).toBeVisible();
	});

	test("Soft line breaks: a paragraph flows with marks, and deleting one joins the lines with one space", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		const line = editor(page).locator(".cm-line", {
			hasText: "The eyes are never still.",
		});
		// The whole paragraph is one visual line with a mark at each join.
		await expect(line).toContainText(
			"Even during steady fixation they drift and make",
		);
		await expect(line).toContainText("Section");
		await expect(line.locator(".rich-softbreak").first()).toHaveText("↳");
		await expect(line.locator(".rich-softbreak")).toHaveCount(5);

		// Backspace after the mark (cursor at the start of the next line).
		await select(page, "small, rapid");
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("Backspace");
		await expect
			.poll(() => onDisk(server))
			.toBe(original.replace("make\nsmall, rapid", "make small, rapid"));
		await expect(line.locator(".rich-softbreak")).toHaveCount(4);

		// Delete before a mark (cursor at the end of the line).
		await select(page, "These");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Delete");
		await expect
			.poll(() => onDisk(server))
			.toBe(
				original
					.replace("make\nsmall, rapid", "make small, rapid")
					.replace("These\nmovements", "These movements"),
			);

		// Enter still makes a real line break, which flows like the others.
		await select(page, "These movements");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Enter");
		await expect
			.poll(() => onDisk(server))
			.toContain("These movements\nmatter");
	});

	test("Figures and tables: the image and the table render", async ({
		page,
	}) => {
		await openPaper(page);
		await select(page, "shows the mean eye position");
		const image = editor(page).getByRole("img", {
			name: "figures/trace.png",
		});
		await expect
			.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
			.toBeGreaterThan(0);
		await select(page, "The gain followed");
		const table = editor(page).getByRole("table");
		await expect(table.getByRole("row")).toHaveCount(4);
		await expect(table.getByRole("cell", { name: "1.37" })).toBeVisible();
	});

	test("Figures: an SVG figure opened on its own cannot act as the app", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		writeFileSync(
			join(server.paper, "figures/evil.svg"),
			`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="document.title='ran in '+origin"><rect width="40" height="40"/></svg>`,
		);
		writeFileSync(
			join(server.paper, "main.tex"),
			original.replace("figures/trace.png", "figures/evil.svg"),
		);
		await page.reload();
		const image = editor(page).getByRole("img", { name: "figures/evil.svg" });
		await expect(async () => {
			await select(page, "shows the mean eye position");
			await expect(image).toBeAttached({ timeout: 1000 });
		}).toPass();
		await expect
			.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
			.toBeGreaterThan(0);

		// What "Open image in new tab" does: the figure must not run in the
		// app's origin, where it could read the page token.
		const src = (await image.getAttribute("src")) ?? "";
		const tab = await page.context().newPage();
		await tab.goto(src);
		expect(await tab.evaluate(() => origin)).not.toBe(server.url);
		await tab.close();
	});

	test("Rich and Source hold the same text and change nothing", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await expect(
			page.getByRole("button", { name: "Rich text" }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(editor(page).getByText("\\documentclass")).toHaveCount(0);
		await expect(
			editor(page).getByRole("button", { name: /Document setup/ }),
		).toBeVisible();
		await editor(page)
			.getByRole("button", { name: /Document setup/ })
			.click();
		await expect(editor(page).getByText("\\documentclass")).toBeVisible();
		expect(await copyAll(page)).toBe(original);
		await showSource(page);
		await expect(editor(page).getByText("\\documentclass")).toBeVisible();
		expect(await copyAll(page)).toBe(original);
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Source", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
		expect(onDisk(server)).toBe(original);
	});
});

test.describe("comments", () => {
	test("Add comment, New author, Package not loaded: the first comment declares the author and loads changes", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await select(page, "never still");
		await page.getByRole("button", { name: "Comment" }).click();
		await page.getByLabel("Your comment").fill("Is this {100%} true?");
		await page.getByRole("button", { name: "Add comment" }).click();
		await confirmAuthor(page);
		const expected = withPreamble(original).replace(
			"never still",
			"\\highlight[id=GH, comment={Is this \\{100\\%\\} true?}]{never still}",
		);
		await expect.poll(() => onDisk(server)).toBe(expected);
		await expect(
			review(page).getByRole("listitem").filter({ hasText: "never still" }),
		).toContainText("Is this {100%} true?");
		await expect(editor(page).getByText("\\highlight")).toHaveCount(0);
	});

	test("Add comment: in an included file, the entry file gets the author declaration", async ({
		page,
		server,
	}) => {
		const methods = readFileSync(
			join(
				import.meta.dirname,
				"../../testdata/manuscript/sections/methods.tex",
			),
			"utf8",
		);
		await openPaper(page);
		await openFromTree(page, "sections/methods.tex");
		await select(page, "velocity threshold");
		await page.getByRole("button", { name: "Comment" }).click();
		await page.getByLabel("Your comment").fill("Which threshold?");
		await page.getByRole("button", { name: "Add comment" }).click();
		await confirmAuthor(page);
		await expect
			.poll(() => onDisk(server, "sections/methods.tex"))
			.toBe(
				methods.replace(
					"velocity threshold",
					"\\highlight[id=GH, comment={Which threshold?}]{velocity threshold}",
				),
			);
		expect(onDisk(server)).toBe(withPreamble(original));
	});

	test("Highlight: marks the selection with no comment, and Remove takes it away", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await select(page, "never still");
		await page.getByRole("button", { name: "Highlight", exact: true }).click();
		await confirmAuthor(page);
		const expected = withPreamble(original).replace(
			"never still",
			"\\highlight[id=GH]{never still}",
		);
		await expect.poll(() => onDisk(server)).toBe(expected);
		await expect(editor(page).locator(".rich-highlight")).toHaveText(
			"never still",
		);
		const item = review(page)
			.getByRole("listitem")
			.filter({ hasText: "never still" });
		await expect(item).toContainText("Highlight");
		await item.getByRole("button", { name: "Remove" }).click();
		await expect.poll(() => onDisk(server)).toBe(withPreamble(original));
	});

	test("Add comment: a refused selection says why", async ({ page }) => {
		await openPaper(page);
		await select(page, "/ R_");
		await page.keyboard.press("Control+Alt+m");
		await page.getByLabel("Your comment").fill("Units?");
		await page.getByRole("button", { name: "Add comment" }).click();
		await expect(page.getByRole("alert")).toContainText(
			"The selection is inside math",
		);
	});

	test("Resolve comment: the macro goes and the text stays", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await seed(
			page,
			server,
			original.replace(
				"never still",
				"\\highlight[id=AB, comment={Too strong?}]{never still}",
			),
			"never still",
		);
		const item = review(page)
			.getByRole("listitem")
			.filter({ hasText: "Too strong?" });
		await expect(item).toContainText("AB");
		await item.getByRole("button", { name: "Resolve" }).click();
		await expect.poll(() => onDisk(server)).toBe(original);
	});
});

const tracked = original.replace(
	"The eyes are never still. Even",
	"The eyes are \\added[id=AB]{never }\\deleted[id=AB]{always }\\replaced[id=AB]{still}{moving}. \\highlight[id=AB, comment={ok}]{Even}",
);

test.describe("tracked changes", () => {
	test("Accept all: every tracked change is applied and comments stay", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await seed(page, server, tracked, "always");
		await expect(page.getByRole("button", { name: /Review/ })).toContainText(
			"4",
		);
		await review(page).getByRole("button", { name: "Accept all" }).click();
		await expect
			.poll(() => onDisk(server))
			.toBe(
				original.replace(
					"never still. Even",
					"never still. \\highlight[id=AB, comment={ok}]{Even}",
				),
			);
	});

	test("Reject all: every tracked change is undone and comments stay", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await seed(page, server, tracked, "always");
		await review(page).getByRole("button", { name: "Reject all" }).click();
		await expect
			.poll(() => onDisk(server))
			.toBe(
				original.replace(
					"The eyes are never still. Even",
					"The eyes are always moving. \\highlight[id=AB, comment={ok}]{Even}",
				),
			);
		await editor(page).click();
		await page.keyboard.press("Control+z");
		await expect.poll(() => onDisk(server)).toBe(tracked);
	});

	test("Accept and reject one change at a time", async ({ page, server }) => {
		await openPaper(page);
		await seed(page, server, tracked, "always");
		await review(page)
			.getByRole("listitem")
			.filter({ hasText: "always" })
			.getByRole("button", { name: "Accept" })
			.click();
		await review(page)
			.getByRole("listitem")
			.filter({ hasText: "never" })
			.getByRole("button", { name: "Reject" })
			.click();
		await expect
			.poll(() => onDisk(server))
			.toBe(
				tracked.replace("\\added[id=AB]{never }\\deleted[id=AB]{always }", ""),
			);
	});

	test("Default plain edit: with tracking off, typing leaves no markup", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await expect(
			page.getByRole("button", { name: "Track changes" }),
		).toHaveAttribute("aria-pressed", "false");
		await select(page, "never still.");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.type(" Really");
		await expect
			.poll(() => onDisk(server))
			.toBe(original.replace("never still.", "never still. Really"));
	});

	test("Tracked edit: typing a word gives one \\added, replacing one gives \\replaced", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await page.getByRole("button", { name: "Track changes" }).click();
		await confirmAuthor(page);
		await expect(
			page.getByRole("button", { name: "Track changes" }),
		).toHaveAttribute("aria-pressed", "true");

		await select(page, "never still.");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.type(" Really");
		const typed = withPreamble(original).replace(
			"never still.",
			"never still.\\added[id=GH]{ Really}",
		);
		await expect.poll(() => onDisk(server)).toBe(typed);

		await select(page, "drift");
		await page.keyboard.type("wander");
		await expect
			.poll(() => onDisk(server))
			.toBe(typed.replace("drift", "\\replaced[id=GH]{wander}{drift}"));
		await expect(editor(page).getByText("\\replaced")).toHaveCount(0);

		await page.keyboard.press("Control+z");
		await page.keyboard.press("Control+z");
		await page.keyboard.press("Control+z");
		await expect.poll(() => onDisk(server)).not.toContain("wander");
	});

	test("Tracked edit: an edit that cannot be tracked goes in plainly and says so", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await page.getByRole("button", { name: "Track changes" }).click();
		await confirmAuthor(page);
		await select(page, "\\vdeg{0.5");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.type("1");
		await expect(page.getByText("was not tracked")).toBeVisible();
		await expect.poll(() => onDisk(server)).toContain("\\vdeg{0.51}");
	});

	test("Markup off: a clean reading view that hides deletions and comments and changes no bytes", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await seed(page, server, tracked, "always");
		const markup = page.getByRole("button", { name: "Markup" });
		await expect(markup).toHaveAttribute("aria-pressed", "true");
		await markup.click();
		await expect(markup).toHaveAttribute("aria-pressed", "false");
		await expect(editor(page).getByText("always")).toHaveCount(0);
		await expect(editor(page).getByText("moving")).toHaveCount(0);
		await expect(
			editor(page).locator(".rich-highlight, .rich-added, .rich-deleted"),
		).toHaveCount(0);
		await expect(editor(page)).toContainText("The eyes are never still. Even");
		await expect(review(page)).toHaveCount(0);
		expect(onDisk(server)).toBe(tracked);

		// Backspace just after hidden deleted text removes the visible
		// character before it, never the hidden text.
		await select(page, "still");
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("Backspace");
		await expect
			.poll(() => onDisk(server))
			.toBe(tracked.replace("{never }", "{never}"));

		// A tracked edit made while markup is hidden is recorded in full.
		await page.getByRole("button", { name: "Track changes" }).click();
		await confirmAuthor(page);
		await select(page, "drift");
		await page.keyboard.type("wander");
		await expect
			.poll(() => onDisk(server))
			.toBe(
				withPreamble(tracked)
					.replace("{never }", "{never}")
					.replace("drift", "\\replaced[id=GH]{wander}{drift}"),
			);
		await expect(editor(page).getByText("drift")).toHaveCount(0);
		await expect(editor(page)).toContainText("wander");

		await markup.click();
		await expect(editor(page).getByText("always")).toBeVisible();
		await expect(review(page)).toBeVisible();
	});

	test("Backspace beside hidden markup never breaks a macro", async ({
		page,
		server,
	}) => {
		await openPaper(page);
		await seed(page, server, tracked, "always");
		await select(page, "always");
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("Backspace");
		await page.keyboard.press("Backspace");
		await expect
			.poll(() => onDisk(server))
			.toBe(tracked.replace("\\added[id=AB]{never }", "\\added[id=AB]{neve}"));
	});
});

test("A comment and a tracked change added in the browser build into a PDF", async ({
	page,
	server,
}) => {
	test.setTimeout(90_000);
	await openPaper(page);
	await select(page, "never still");
	await page.getByRole("button", { name: "Comment" }).click();
	await page.getByLabel("Your comment").fill("Check & cite");
	await page.getByRole("button", { name: "Add comment" }).click();
	await confirmAuthor(page);
	await page.getByRole("button", { name: "Track changes" }).click();
	await select(page, "drift");
	await page.keyboard.type("wander");
	await expect.poll(() => onDisk(server)).toContain("\\replaced[id=GH]");
	await page.getByRole("button", { name: "Build PDF" }).click();
	await expect(page.locator('[data-page="1"] canvas')).toHaveCount(1, {
		timeout: 60_000,
	});
	await expect(page.getByText("The PDF could not be built")).toHaveCount(0);
	await showSource(page);
	await expect(editor(page).getByText("\\highlight[id=GH")).toBeVisible();
});

// A manuscript shaped like the one that showed text popping in while
// scrolling: one long paragraph per line, many inline formulas.
function largeManuscript(): string {
	const sentence =
		"Responses near $x_{i}^{2} + \\alpha$ grew \\emph{steadily} with contrast \\citep{rolfs2009}, and the gain $g = R_{\\text{post}} / R_{\\text{pre}}$ stayed above one. ";
	const lines = ["\\documentclass{article}", "\\begin{document}"];
	for (let i = 0; i < 300; i++) {
		lines.push(`Paragraph ${i}. ${sentence.repeat(8)}`, "");
		if (i % 25 === 0)
			lines.push("\\begin{equation}", `E_{${i}} = mc^2`, "\\end{equation}", "");
	}
	lines.push("\\end{document}", "");
	return lines.join("\n");
}

test("Large manuscript: a quiet poll redraws nothing, and scrolling stays quick", async ({
	page,
	server,
}) => {
	test.setTimeout(60_000);
	await openPaper(page);
	await seed(page, server, largeManuscript(), "Paragraph 0.");
	const added = () =>
		page.evaluate(async () => {
			const content = document.querySelector(".cm-content") as HTMLElement;
			let n = 0;
			const watch = new MutationObserver((list) => {
				for (const m of list)
					for (const node of m.addedNodes)
						if (
							node instanceof HTMLElement &&
							/rich-(math|chip)/.test(node.className)
						)
							n++;
			});
			watch.observe(content, { childList: true, subtree: true });
			// Two polls of the disk check.
			await new Promise((r) => setTimeout(r, 4500));
			watch.disconnect();
			return n;
		});
	expect(await added()).toBe(0);

	// After an edit, its save, and the polls that follow, only text changed.
	await select(page, "Paragraph 3.");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.type("x");
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(await added()).toBe(0);

	// Each jump of a few screens draws new lines; the bound is generous so
	// only a gross regression (re-rendering every formula) fails it.
	const slowest = await page.evaluate(async () => {
		const scroller = document.querySelector(".cm-scroller") as HTMLElement;
		const frame = () => new Promise((r) => requestAnimationFrame(r));
		let worst = 0;
		while (
			scroller.scrollTop + scroller.clientHeight <
			scroller.scrollHeight - 10
		) {
			const start = performance.now();
			scroller.scrollTop += 2500;
			await frame();
			await frame();
			worst = Math.max(worst, performance.now() - start);
		}
		return worst;
	});
	expect(slowest).toBeLessThan(1000);
});
