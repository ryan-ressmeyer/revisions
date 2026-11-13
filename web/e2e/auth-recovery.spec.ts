import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { editorText, expect, PAPER, showSource, test } from "./fixtures";

test.use({ serverEnv: { REVISIONS_GITHUB_TOKEN: "" } });

async function signIn(page: Page) {
	await page.goto("/");
	await page.getByRole("button", { name: "Sign in with GitHub" }).click();
	await expect(page.getByText("WDJB-MJHT")).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function open(page: Page) {
	await page.getByLabel("GitHub link").fill(PAPER.url);
	await page.getByRole("button", { name: "Open", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
}

test("Reconnect keeps the pasted URL and never replays Open", async ({
	page,
	server,
}) => {
	await signIn(page);
	await page.getByLabel("GitHub link").fill(`${PAPER.url}/tree/main`);
	writeFileSync(join(server.configDir, "github-token"), "revoked");
	let opens = 0;
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().endsWith("/api/open")) opens++;
	});
	await page.getByRole("button", { name: "Open", exact: true }).click();
	await expect(page.getByText(/GitHub is disconnected/).first()).toBeVisible();
	await page
		.getByRole("button", { name: "Reconnect GitHub", exact: true })
		.first()
		.click();
	await expect(
		page.getByRole("dialog", { name: "Reconnect GitHub" }),
	).toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByLabel("GitHub link")).toHaveValue(
		`${PAPER.url}/tree/main`,
	);
	expect(opens).toBe(1);
	await page.getByRole("button", { name: "Open", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible();
});

test("Reconnect and cancellation retain stale-save text and the same editor undo history", async ({
	page,
	server,
}) => {
	await signIn(page);
	await open(page);
	await showSource(page);
	const source = page.getByRole("textbox", { name: "Source" });
	await source.evaluate((el) => {
		el.setAttribute("data-recovery-identity", "same");
	});
	await source.click();
	await page.keyboard.press("Control+Home");
	await page.keyboard.insertText("% mine\n");
	const main = join(server.paper, "main.tex");
	writeFileSync(main, `% external\n${readFileSync(main, "utf8")}`);
	await expect(page.getByLabel("Your unsaved text")).toHaveValue(/^% mine\n/);
	writeFileSync(join(server.configDir, "github-token"), "revoked");
	await page.getByRole("button", { name: /Changes & history/ }).click();
	await expect(page.getByText(/GitHub is disconnected/).first()).toBeVisible();
	// Keep the flow pending, so cancellation is exercised before approval.
	await page.route("**/api/auth/device/poll", (route) =>
		route.fulfill({ json: { status: "pending" } }),
	);
	await page
		.getByRole("button", { name: "Reconnect GitHub", exact: true })
		.first()
		.click();
	const reconnect = page.getByRole("dialog", { name: "Reconnect GitHub" });
	await expect(reconnect.getByText("WDJB-MJHT")).toBeVisible();
	await reconnect.getByRole("button", { name: "Not now" }).click();
	await expect(source).toHaveAttribute("data-recovery-identity", "same");
	await expect(page.getByLabel("Your unsaved text")).toHaveValue(/^% mine\n/);
	await source.click();
	await page.keyboard.press("Control+z");
	expect(await editorText(page)).not.toMatch(/^% mine/);
	await page
		.getByRole("button", { name: "Reconnect GitHub", exact: true })
		.first()
		.click();
	await page.unroute("**/api/auth/device/poll");
	await expect(reconnect).toHaveCount(0);
	await expect(source).toHaveAttribute("data-recovery-identity", "same");
});

test.describe("environment override", () => {
	test.use({ serverEnv: { REVISIONS_GITHUB_TOKEN: "revoked" } });
	test("A rejected override explains configuration without offering a sign-in loop", async ({
		page,
	}) => {
		let devices = 0;
		page.on("request", (r) => {
			if (r.url().endsWith("/api/auth/device")) devices++;
		});
		await page.goto("/");
		await expect(
			page.getByText(/Replace or remove it and restart/),
		).toBeVisible();
		await expect(page.getByLabel("GitHub link")).toBeVisible();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page
			.getByRole("button", { name: "Reconnect GitHub", exact: true })
			.click();
		const dialog = page.getByRole("dialog", { name: "Reconnect GitHub" });
		await expect(dialog.getByRole("alert")).toContainText(
			"REVISIONS_GITHUB_TOKEN",
		);
		await expect(
			dialog.getByRole("button", { name: "Start a new sign-in" }),
		).toHaveCount(0);
		expect(devices).toBe(0);
	});
});

for (const saving of ["pending", "failed"] as const) {
	test(`Sign-out and reconnect retain ${saving} text and editor identity`, async ({
		page,
		server,
	}) => {
		await signIn(page);
		await open(page);
		await showSource(page);
		const source = page.getByRole("textbox", { name: "Source" });
		await source.evaluate((el) =>
			el.setAttribute("data-recovery-identity", "same"),
		);
		await page.route("**/file?*", (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			if (saving === "failed")
				return route.fulfill({
					status: 500,
					json: { error: { code: "internal", message: "Test write failed" } },
				});
		});
		await source.click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.insertText(`% ${saving}\n`);
		if (saving === "failed")
			await expect(
				page.getByText(/Your changes could not be saved/),
			).toBeVisible();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Sign out", exact: true }).click();
		await expect(source).toHaveAttribute("data-recovery-identity", "same");
		await page
			.getByRole("button", { name: "Sign in with GitHub", exact: true })
			.click();
		await expect(
			page.getByRole("dialog", { name: "Reconnect GitHub" }),
		).toHaveCount(0);
		await expect(source).toHaveAttribute("data-recovery-identity", "same");
		expect(await editorText(page)).toMatch(new RegExp(`^% ${saving}`));
		expect(readFileSync(join(server.paper, "main.tex"), "utf8")).not.toMatch(
			new RegExp(`^% ${saving}`),
		);
	});
}

test("A rejected PR keeps its form through reconnect without automatic resubmission", async ({
	page,
	server,
}) => {
	await signIn(page);
	await open(page);
	await page.getByRole("button", { name: /Changes & history/ }).click();
	await page.getByRole("button", { name: "Pull request…" }).click();
	const pr = page.getByRole("dialog", { name: "Open a pull request" });
	await pr.getByLabel("Title", { exact: true }).fill("Keep my title");
	await pr.getByLabel("Description").fill("Keep my description");
	writeFileSync(join(server.configDir, "github-token"), "revoked");
	let attempts = 0;
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().endsWith("/pulls")) attempts++;
	});
	await pr.getByRole("button", { name: "Open pull request" }).click();
	await pr
		.getByRole("button", { name: "Reconnect GitHub", exact: true })
		.click();
	await expect(
		page.getByRole("dialog", { name: "Reconnect GitHub" }),
	).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "Reconnect GitHub" }),
	).toHaveCount(0);
	await expect(pr.getByLabel("Title", { exact: true })).toHaveValue(
		"Keep my title",
	);
	await expect(pr.getByLabel("Description")).toHaveValue("Keep my description");
	expect(attempts).toBe(1);
});
