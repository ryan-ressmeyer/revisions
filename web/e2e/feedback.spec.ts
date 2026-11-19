import type { Page } from "@playwright/test";
import { expect, openPaper, test } from "./fixtures";

/** The query of the Feedback menu's link named `name`. */
async function formFor(page: Page, name: string) {
	await page.getByRole("button", { name: "Feedback" }).click();
	const link = page
		.getByRole("navigation", { name: "Feedback" })
		.getByRole("link", { name });
	await expect(link).toHaveAttribute("target", "_blank");
	const url = new URL((await link.getAttribute("href")) ?? "");
	await page.getByRole("button", { name: "Feedback" }).click();
	return url;
}

test("Give feedback: each kind opens its GitHub form filled in with the version and platform, on the start page and in a project", async ({
	page,
}) => {
	await page.goto("/");
	const idea = await formFor(page, "I have an idea");
	expect(`${idea.origin}${idea.pathname}`).toBe(
		"https://github.com/ryan-ressmeyer/revisions/issues/new",
	);
	expect(idea.searchParams.get("template")).toBe("idea.yml");
	expect(idea.searchParams.get("environment")).toMatch(
		/^Revisions \S+\nPlatform: (darwin|linux|windows)\nGit: /,
	);
	expect(
		(await formFor(page, "Something doesn't work")).searchParams.get(
			"template",
		),
	).toBe("bug.yml");

	await openPaper(page);
	expect(
		(await formFor(page, "Something was confusing")).searchParams.get(
			"template",
		),
	).toBe("confusing.yml");
});

test("Report a failure: an uncaught error in the page fills in the problem report", async ({
	page,
}) => {
	await openPaper(page);
	await page.evaluate(() => {
		setTimeout(() => {
			throw new Error("boom from the test");
		});
		Promise.reject(new Error("rejected in the test"));
	});
	await expect
		.poll(async () =>
			(await formFor(page, "Something doesn't work")).searchParams.get(
				"problem",
			),
		)
		.toMatch(/^Error: (boom|rejected) (from|in) the test$/);
});
