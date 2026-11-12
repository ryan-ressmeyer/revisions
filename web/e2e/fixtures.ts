import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test as base, expect, type Page } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const binary = join(
	root,
	"bin",
	process.platform === "win32" ? "revisions.exe" : "revisions",
);

/** The seeded repository every test can open. */
export const PAPER = {
	url: "https://github.com/ada/paper",
	id: "github.com/ada/paper",
};

export interface Fake {
	apiUrl: string;
	webUrl: string;
	token: string;
	/** Directory holding the bare repositories as `<owner>/<name>.git`. */
	remotes: string;
}

export interface Server {
	url: string;
	/** REVISIONS_HOME: clones are at `<home>/<host>/<owner>/<name>`. */
	home: string;
	configDir: string;
	cacheDir: string;
	/** The clone of {@link PAPER} once it is opened. */
	paper: string;
	/** Resolves with the exit code once the process has ended. */
	exited: Promise<number | null>;
	stop(): Promise<void>;
}

/**
 * Starts bin/revisions on fresh temporary directories, pointed at `fake` and
 * signed in unless `env` empties REVISIONS_GITHUB_TOKEN.
 */
export async function startServer(
	fake: Fake,
	env: Record<string, string> = {},
): Promise<Server> {
	const dir = mkdtempSync(join(tmpdir(), "revisions-e2e-"));
	const port = await freePort();
	const home = join(dir, "home");
	const child = spawn(binary, ["--no-browser", "--port", String(port)], {
		stdio: "inherit",
		env: {
			...process.env,
			REVISIONS_HOME: home,
			REVISIONS_CONFIG_DIR: join(dir, "config"),
			REVISIONS_CACHE_DIR: join(dir, "cache"),
			REVISIONS_GITHUB_API_URL: fake.apiUrl,
			REVISIONS_GITHUB_URL: fake.webUrl,
			REVISIONS_GITHUB_CLIENT_ID: "e2e",
			REVISIONS_TOKEN_STORE: "file",
			REVISIONS_GITHUB_TOKEN: fake.token,
			...env,
		},
	});
	const exited = once(child, "exit");
	const url = `http://127.0.0.1:${port}`;
	const stop = async () => {
		child.kill();
		await exited;
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		await waitForPing(url, child);
	} catch (error) {
		await stop();
		throw error;
	}
	return {
		url,
		home,
		configDir: join(dir, "config"),
		cacheDir: join(dir, "cache"),
		paper: join(home, PAPER.id),
		exited: exited.then(([code]) => code as number | null),
		stop,
	};
}

/**
 * One GitHub fake per worker, with {@link PAPER} seeded from
 * testdata/manuscript and the device flow approving on the first poll. Every
 * test gets its own server, and `page` navigates relative to it. A file sets
 * extra environment for its server with `test.use({ serverEnv: {...} })`.
 */
export const test = base.extend<
	{ serverEnv: Record<string, string>; server: Server },
	{ fake: Fake }
>({
	fake: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from the destructuring
		async ({}, use) => {
			const fake = await startFake();
			await use(fake);
			await fake.stop();
		},
		{ scope: "worker" },
	],

	serverEnv: [{}, { option: true }],

	server: async ({ fake, serverEnv }, use) => {
		const server = await startServer(fake, serverEnv);
		try {
			await use(server);
		} finally {
			await server.stop();
		}
	},

	baseURL: async ({ server }, use) => {
		await use(server.url);
	},
});

export { expect };

/**
 * Starts a GitHub fake with {@link PAPER} seeded from testdata/manuscript
 * and the device flow approving on the first poll. `args` adds flags, such
 * as `-push=false`.
 */
export async function startFake(
	args: string[] = [],
): Promise<Fake & { stop(): Promise<void> }> {
	const program = process.env.REVISIONS_E2E_GITHUBFAKE;
	if (!program) throw new Error("global-setup did not build githubfake");
	const remotes = mkdtempSync(join(tmpdir(), "revisions-remotes-"));
	const child = spawn(
		program,
		[
			"-remotes",
			remotes,
			"-seed",
			`ada/paper=${join(root, "testdata/manuscript")}`,
			"-auto-approve",
			...args,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	const exited = once(child, "exit");
	const line = await firstLine(child);
	return {
		...JSON.parse(line),
		remotes,
		stop: async () => {
			child.kill();
			await exited;
			rmSync(remotes, { recursive: true, force: true });
		},
	};
}

/** Pastes {@link PAPER}'s URL on the home screen and waits for the editor. */
export async function openPaper(page: Page) {
	await page.goto("/");
	await page.getByLabel("GitHub link").fill(PAPER.url);
	await page.getByRole("button", { name: "Open" }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible({
		timeout: 15_000,
	});
}

/** Opens `path` from the file tree, expanding the folders on the way. */
export async function openFromTree(page: Page, path: string) {
	const tree = page.getByRole("tree", { name: "Files" });
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i++) {
		const folder = tree.locator(`[data-path="${parts.slice(0, i).join("/")}"]`);
		if ((await folder.getAttribute("aria-expanded")) !== "true")
			await folder.click();
	}
	await tree.locator(`[data-path="${path}"]`).click();
}

/** The name of the file open in the editor, in the editor's toolbar. */
export const openFileName = (page: Page) =>
	page.getByRole("region", { name: "Editor" }).locator(".file-name");

/** Switches the editor to Source mode, where every character shows. */
export async function showSource(page: Page) {
	const button = page.getByRole("button", { name: "Source", exact: true });
	if ((await button.getAttribute("aria-pressed")) !== "true")
		await button.click();
	await expect(button).toHaveAttribute("aria-pressed", "true");
}

/** The text of the source editor, one line per CodeMirror line. Switches
 * to Source mode first. */
export async function editorText(page: Page): Promise<string> {
	await showSource(page);
	return page
		.locator(".cm-content")
		.evaluate((el) =>
			[...el.querySelectorAll(".cm-line")]
				.map((line) => line.textContent)
				.join("\n"),
		);
}

async function firstLine(child: ChildProcess): Promise<string> {
	if (!child.stdout) throw new Error("no stdout");
	const lines = createInterface({ input: child.stdout });
	for await (const line of lines) return line;
	throw new Error("githubfake exited without printing its address");
}

// A free port rather than a fixed one, so that several worktrees can run their
// end-to-end tests at the same time.
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer().once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

async function waitForPing(url: string, child: { exitCode: number | null }) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) break;
		const up = await fetch(`${url}/api/ping`).then(
			(r) => r.ok,
			() => false,
		);
		if (up) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`bin/revisions did not start at ${url}; run make build`);
}

/** The block that draws comments inline where a margin note cannot go. */
export const inlineNotes = [
	"% Added by Revisions: draw comments inline where LaTeX cannot place a margin note.",
	"\\ifdefined\\setuptodonotes\\ifdefined\\AddToHook",
	"\\AddToHook{cmd/todo/before}{\\ifinner\\setuptodonotes{inline, inlinewidth=10em}\\fi}% boxes, table cells",
	"\\AddToHook{cmd/@arrayparboxrestore/after}{\\setuptodonotes{inline}}% floats, footnotes",
	"\\AddToHook{env/abstract/begin}{\\setuptodonotes{inline}}% abstracts",
	"\\AddToHook{env/frontmatter/begin}{\\setuptodonotes{inline}}% elsarticle title block",
	"\\fi\\fi",
].join("\n");
