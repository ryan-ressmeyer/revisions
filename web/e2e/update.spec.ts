import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, openPaper, startServer, test } from "./fixtures";

const root = resolve(import.meta.dirname, "../..");

/** Builds bin/revisions' source, web UI included, stamped with `version`. */
function build(out: string, version: string) {
	execFileSync(
		"go",
		[
			"build",
			"-ldflags",
			`-X main.version=${version}`,
			"-o",
			out,
			"./cmd/revisions",
		],
		{ cwd: root, stdio: "inherit" },
	);
}

test("Update: the notice offers the new version, and Update saves, installs it, and the tab comes back on it", async ({
	page,
	fake,
}) => {
	test.setTimeout(180_000);
	const dir = mkdtempSync(join(tmpdir(), "revisions-update-"));
	const [os, arch] = execFileSync("go", ["env", "GOOS", "GOARCH"], {
		encoding: "utf8",
	}).split("\n");
	const ext = os === "windows" ? ".exe" : "";
	const asset = `revisions-${os}-${arch}${ext}`;
	const program = join(dir, `revisions${ext}`);
	mkdirSync(join(dir, "release"));
	build(program, "v0.0.1");
	build(join(dir, "release", asset), "v0.0.2");
	const newer = readFileSync(join(dir, "release", asset));
	const sums = `${createHash("sha256").update(newer).digest("hex")}  ${asset}\n`;

	// A local copy of the release page, through the test-only override.
	const release = createServer((req, res) => {
		if (req.url === "/latest") res.end(JSON.stringify({ tag_name: "v0.0.2" }));
		else if (req.url === "/download/v0.0.2/SHA256SUMS") res.end(sums);
		else if (req.url === `/download/v0.0.2/${asset}`) res.end(newer);
		else res.writeHead(404).end();
	}).listen(0, "127.0.0.1");
	await once(release, "listening");
	const { port } = release.address() as AddressInfo;
	const server = await startServer(
		fake,
		{ REVISIONS_RELEASES_URL: `http://127.0.0.1:${port}` },
		program,
	);
	try {
		const notice = page.getByRole("region", { name: "Update available" });
		// The check runs in the background as the program starts.
		await expect(async () => {
			await page.goto(server.url);
			await expect(notice).toBeVisible({ timeout: 1000 });
		}).toPass({ timeout: 20_000 });
		await expect(notice).toContainText("Version 0.0.2 is available.");
		await expect(
			notice.getByRole("link", { name: "Release notes" }),
		).toHaveAttribute(
			"href",
			"https://github.com/ryan-ressmeyer/revisions/releases/tag/v0.0.2",
		);

		await openPaper(page, server.url);
		await expect(notice).toBeVisible();
		await page.getByRole("button", { name: "Settings" }).click();
		const settings = page.getByRole("dialog");
		await expect(settings).toContainText("Revisions 0.0.1");
		await expect(
			settings.getByRole("region", { name: "Update available" }),
		).toBeVisible();
		await settings.getByRole("button", { name: "Cancel" }).click();

		// Update saves the edit first, as Quit does.
		const order: string[] = [];
		page.on("requestfinished", (r) => {
			if (r.method() === "PUT" && r.url().includes("/file?"))
				order.push("save");
		});
		page.on("request", (r) => {
			if (r.method() === "POST" && r.url().endsWith("/api/update"))
				order.push("update");
		});
		await page.getByRole("textbox", { name: "Source" }).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.type("% before the update\n");
		await notice.getByRole("button", { name: "Update" }).click();
		await expect(
			page.getByRole("heading", { name: "Updating Revisions" }),
		).toBeVisible();

		// The tab reloads itself on the new version, in the same project.
		await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(notice).toHaveCount(0);
		await page.getByRole("button", { name: "Settings" }).click();
		await expect(page.getByRole("dialog")).toContainText("Revisions 0.0.2");
		expect(order.indexOf("save")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("save")).toBeLessThan(order.indexOf("update"));
		expect(
			readFileSync(join(server.paper, "main.tex"), "utf8").startsWith(
				"% before the update\n",
			),
		).toBe(true);
		expect(execFileSync(program, ["--version"], { encoding: "utf8" })).toBe(
			"revisions v0.0.2\n",
		);
		expect(page.context().pages()).toHaveLength(1);
	} finally {
		await server.stop();
		release.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
