// Stress test for saves racing Git operations, from the 2026-11-16 investigation
// recorded in notes/grill-git-workflow-01.md. It records an outcome class per
// iteration (OK, BLOCKED, CROSSED, CARRIED, LOST, SNAPSHOT-WRITTEN, ...) to
// RACE_WORK/logs/results-<regime>.jsonl and asserts nothing yet: the
// "Saves around Git operations" requirement in specs/git-workflow.md turns the
// LOST and SNAPSHOT-WRITTEN outcomes into failures.
//
// Skipped unless RACE_WORK (an output directory) is set, so `make e2e` skips it.
// RACE_N sets iterations per case (default 10). RACE_WIDEN=1 puts
// e2e/race-shim/git first on the server's PATH (or RACE_SHIM_DIR), which sleeps
// 0.5-2 s before switch, merge, reset, restore, checkout, and fetch.
// From web/, after `make build`:
//   RACE_WORK=/tmp/race RACE_N=15 npx playwright test e2e/save-race.spec.ts --workers=7
//   RACE_WORK=/tmp/race RACE_WIDEN=1 RACE_N=10 npx playwright test e2e/save-race.spec.ts --grep-invert "terminal-switch|http:" --workers=7
//   node e2e/race-summarize.mjs /tmp/race/logs/results-natural.jsonl /tmp/race/logs/results-widened.jsonl
import { execFile, execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "@playwright/test";
import {
	test as base,
	expect,
	type Fake,
	PAPER,
	type Server,
	showSource,
	startFake,
	startServer,
} from "./fixtures";

const WORK = process.env.RACE_WORK ?? "";
const WIDEN = process.env.RACE_WIDEN === "1";
const N = Number(process.env.RACE_N ?? 10);
const REGIME = WIDEN ? "widened" : "natural";
if (WORK) mkdirSync(join(WORK, "logs"), { recursive: true });
const LOG = join(WORK, "logs", `results-${REGIME}.jsonl`);
const run = promisify(execFile);

const test = base.extend<{ github: Fake }>({
	// biome-ignore lint/correctness/noEmptyPattern: fixture
	github: async ({}, use) => {
		const fake = await startFake();
		await use(fake);
		await fake.stop();
	},
	server: async ({ github }, use) => {
		const env: Record<string, string> = WIDEN
			? {
					PATH: `${process.env.RACE_SHIM_DIR ?? join(process.cwd(), "e2e", "race-shim")}:${process.env.PATH}`,
					RACE_SHIM_LOG: join(WORK, "logs", "shim.log"),
				}
			: {};
		const s = await startServer(github, env);
		try {
			await use(s);
		} finally {
			await s.stop();
		}
	},
});
test.skip(!WORK, "stress test: set RACE_WORK to run it");
test.describe.configure({ mode: "parallel" });

const identity = {
	GIT_AUTHOR_NAME: "Ada Example",
	GIT_AUTHOR_EMAIL: "ada@example.com",
	GIT_COMMITTER_NAME: "Ada Example",
	GIT_COMMITTER_EMAIL: "ada@example.com",
};
const gitRaw = (dir: string, ...args: string[]) =>
	execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...identity },
	});
const git = (dir: string, ...args: string[]) => gitRaw(dir, ...args).trim();
const bare = (fake: Fake) => join(fake.remotes, "ada/paper.git");

function coauthor(fake: Fake) {
	const dir = mkdtempSync(join(tmpdir(), "revisions-coauthor-"));
	git(dir, "clone", "--quiet", bare(fake), ".");
	return {
		dir,
		git: (...args: string[]) => git(dir, ...args),
		commitFile(path: string, text: string, subject: string) {
			writeFileSync(join(dir, path), text);
			git(dir, "add", path);
			git(dir, "commit", "--quiet", "-m", subject);
			git(dir, "push", "--quiet", "origin", "HEAD");
		},
		retitle(title: string) {
			const f = join(dir, "main.tex");
			writeFileSync(
				f,
				readFileSync(f, "utf8").replace(
					/\\title\{[^}]*\}/,
					`\\title{${title}}`,
				),
			);
			git(dir, "commit", "--quiet", "-am", `Title ${title}`);
			git(dir, "push", "--quiet", "origin", "HEAD");
		},
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

const SIDE = "sidebranch";
const R = "/api/repos/github.com/ada/paper";

// Records keystrokes, clicks, and every change of what the page shows, with
// the wall clock, so each keystroke knows which version was on screen.
function instrument() {
	// biome-ignore lint/suspicious/noExplicitAny: test hook
	const w = window as any;
	w.__ev = [];
	const snap = () => ({
		where: document.querySelector(".topbar .repo .where")?.textContent ?? "",
		status: document.querySelector(".save-status")?.textContent ?? "",
		modal: !!document.querySelector("dialog[open]"),
		ro:
			document.querySelector(".cm-content")?.getAttribute("aria-readonly") ===
			"true",
	});
	document.addEventListener(
		"keydown",
		(e) => {
			const a = document.activeElement;
			w.__ev.push({
				t: Date.now(),
				type: "key",
				key: e.key,
				inEditor: !!a?.closest?.(".cm-editor"),
				...snap(),
			});
		},
		true,
	);
	document.addEventListener(
		"click",
		(e) => {
			const t = e.target as Element;
			w.__ev.push({
				t: Date.now(),
				type: "click",
				target: (t.closest?.("button,a")?.textContent ?? t.className ?? "")
					.toString()
					.slice(0, 40),
				...snap(),
			});
		},
		true,
	);
	let last = "";
	setInterval(() => {
		const s = snap();
		const k = JSON.stringify(s);
		if (k !== last) {
			last = k;
			w.__ev.push({ t: Date.now(), type: "state", ...s });
		}
	}, 5);
}

type Net = {
	t: number;
	ev: string;
	m: string;
	u: string;
	s?: number;
	code?: string;
};
function netLog(page: Page, tag: string, out: Net[]) {
	page.on("request", (r) => {
		if (r.url().includes("/api/") && r.method() !== "GET")
			out.push({
				t: Date.now(),
				ev: `${tag}:req`,
				m: r.method(),
				u: short(r.url()),
			});
	});
	page.on("response", async (r) => {
		const q = r.request();
		if (!r.url().includes("/api/") || q.method() === "GET") return;
		const t = Date.now();
		let code: string | undefined;
		if (r.status() >= 400)
			code = await r
				.json()
				.then((j) => j?.error?.code)
				.catch(() => "?");
		out.push({
			t,
			ev: `${tag}:res`,
			m: q.method(),
			u: short(r.url()),
			s: r.status(),
			code,
		});
	});
}
const short = (u: string) =>
	u
		.replace(/^.*\/api\/repos\/[^/]+\/[^/]+\/[^/]+/, "R")
		.replace(/^.*\/api/, "/api");

/** One entry recorded by `instrument`: a key, a click, or a change on screen. */
interface Ev {
	t: number;
	type: "key" | "click" | "state";
	key?: string;
	inEditor?: boolean;
	where: string;
	status: string;
	modal: boolean;
	ro: boolean;
}
const events = (page: Page) =>
	page
		.evaluate(() => (window as unknown as { __ev: Ev[] }).__ev)
		.catch((): Ev[] => []);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => Math.round(a + Math.random() * (b - a));

async function newTab(page: Page): Promise<Page> {
	const p = await page.context().newPage();
	p.on("dialog", (d) => d.accept().catch(() => {}));
	return p;
}

async function openRepo(page: Page, url = PAPER.url) {
	await page.goto("/");
	await page.getByLabel("GitHub link").fill(url);
	await page.getByRole("button", { name: "Open" }).click();
	await expect(page.getByRole("textbox", { name: "Source" })).toBeVisible({
		timeout: 15_000,
	});
}

/** Reloads the page and waits until it shows a clean, loaded file. */
async function load(page: Page, url: string) {
	if (page.url() === url) await page.reload();
	else await page.goto(url);
	await expect(page.locator(".cm-content")).toBeVisible({ timeout: 15_000 });
	await expect(page.locator(".topbar .repo .where")).toHaveText(
		/on branch|Read-only: earlier version/,
	);
	await showSource(page);
	await expect(page.locator(".save-status")).toHaveText(/Saved|Read-only/);
}

/** Opens the header dialog on a snapshot and finds its Return to main. */
async function returnButton(page: Page): Promise<Locator> {
	await page
		.getByRole("banner")
		.getByRole("button", { name: "Read-only: earlier version" })
		.click();
	return page
		.getByRole("dialog", { name: "This is an earlier version" })
		.getByRole("button", { name: "Return to main" });
}

const panel = (page: Page) =>
	page.getByRole("region", { name: "Changes & history" });
async function openPanel(page: Page): Promise<Locator> {
	await page.getByRole("button", { name: /Changes & history/ }).click();
	await expect(
		panel(page).getByRole("list", { name: "History" }),
	).toBeVisible();
	return panel(page);
}

async function editorPoint(page: Page) {
	const box = await page.locator(".cm-content").boundingBox();
	if (!box) throw new Error("no editor");
	return { x: box.x + 120, y: box.y + 30 };
}
const editorDoc = (page: Page) =>
	page
		.locator(".cm-content")
		.evaluate(
			(el) =>
				[...el.querySelectorAll(".cm-line")]
					.map((l) => l.textContent)
					.join("\n"),
			undefined,
			{ timeout: 1000 },
		)
		.catch(() => "");

/** A human-like burst: click into the editor, then type. */
async function typeAt(
	page: Page,
	pt: { x: number; y: number },
	text: string,
	delay = 35,
) {
	// Aim where the editor is now, as a person would after a layout shift
	// (the snapshot banner pushes the editor down).
	const at = await editorPoint(page).catch(() => pt);
	await page.mouse.click(at.x, at.y);
	await page.keyboard.type(text, { delay });
}

function inserted(base: string, now: string) {
	let i = 0;
	while (i < base.length && i < now.length && base[i] === now[i]) i++;
	let j = 0;
	while (
		j < base.length - i &&
		j < now.length - i &&
		base[base.length - 1 - j] === now[now.length - 1 - j]
	)
		j++;
	return now.slice(i, now.length - j);
}
const marker = (i: number, long = false) =>
	long ? `QJ${i}XVKQJXVKQJXVKQJXV` : `QJ${i}XVK`;
const hasMark = (s: string) => /[QJXVK]/.test(s);

function api(page: Page, method: string, path: string, body?: unknown) {
	return page.evaluate(
		async ([m, p, b]) => {
			const tok =
				document
					.querySelector('meta[name="revisions-token"]')
					?.getAttribute("content") ?? "";
			const t0 = Date.now();
			const r = await fetch(p as string, {
				method: m as string,
				headers: {
					"X-Revisions-Token": tok,
					"Content-Type": "application/json",
				},
				body: b === undefined ? undefined : JSON.stringify(b),
			});
			return {
				t0,
				t1: Date.now(),
				status: r.status,
				body: (await r.text()).slice(0, 300),
			};
		},
		[method, R + path, body] as const,
	);
}

interface Iter {
	case: string;
	i: number;
	offsetMs: number;
	extra?: Record<string, unknown>;
	before: string; // editor text before typing
	page: Page; // the page that typed
	opPage: Page; // the page that ran the operation
	net: Net[];
	opMatch: RegExp; // which request is the operation
	discard?: boolean;
}

async function collect(server: Server, it: Iter) {
	await sleep(3600); // autosave (1 s) + a 2 s poll + margin
	const branch = git(server.paper, "branch", "--show-current");
	const head = git(server.paper, "rev-parse", "--short", "HEAD");
	const porcelain = git(server.paper, "status", "--porcelain");
	const disk = readFileSync(join(server.paper, "main.tex"), "utf8");
	const headText = gitRaw(server.paper, "show", "HEAD:main.tex");
	const ed = await editorDoc(it.page);
	const status = await it.page
		.locator(".save-status")
		.textContent({ timeout: 300 })
		.catch(() => "");
	const banners = (
		await it.page
			.locator(".banner.danger")
			.allTextContents()
			.catch(() => [])
	).map((s) => s.slice(0, 160));
	const collisionText = await it.page
		.getByLabel("Your unsaved text")
		.inputValue({ timeout: 200 })
		.catch(() => "");
	const opAlerts = (
		await it.opPage
			.locator('[role="alert"]')
			.allTextContents()
			.catch(() => [])
	)
		.filter((s) => !s.includes("settings could not be loaded"))
		.map((s) => s.slice(0, 200));
	const opDone =
		(await it.opPage
			.locator(".git-done")
			.textContent({ timeout: 300 })
			.catch(() => "")) ?? "";
	const ev = await events(it.page);
	const opEv = it.opPage === it.page ? ev : await events(it.opPage);

	const diskIns = inserted(headText, disk);
	const edIns =
		[inserted(it.before, ed), inserted(headText, ed)].sort(
			(a, b) => a.length - b.length,
		)[0] ?? "";
	const keys = ev.filter(
		(e) => e.type === "key" && /^[QJXVK0-9]$/.test(e.key ?? ""),
	);
	const editable = keys.filter((k) => k.inEditor && !k.ro && !k.modal);
	const shown = [...new Set(editable.map((k) => k.where))];

	const opReq = it.net.find(
		(n) => n.ev.endsWith(":req") && it.opMatch.test(`${n.m} ${n.u}`),
	);
	const opRes = it.net.find(
		(n) => n.ev.endsWith(":res") && it.opMatch.test(`${n.m} ${n.u}`),
	);
	const puts = it.net.filter(
		(n) => n.ev.endsWith(":res") && n.m === "PUT" && n.u.startsWith("R/file"),
	);
	const t0 = opReq?.t ?? 0;
	const whereBefore = opEv.filter((e) => e.t <= t0).at(-1)?.where;
	const whereChange = opEv.find(
		(e) => e.type === "state" && e.t > t0 && e.where !== whereBefore,
	);
	const roBefore = opEv.filter((e) => e.t <= t0).at(-1)?.ro;
	const roChange = opEv.find(
		(e) => e.type === "state" && e.t > t0 && e.ro !== roBefore,
	);

	const revived =
		!!it.discard && /DISCARDME/.test(disk) && /discarded/.test(opDone);
	const opRefused = opRes?.s && opRes.s >= 400 ? opRes.code : undefined;
	let outcome: string;
	if (revived) outcome = "REVIVED";
	else if (hasMark(diskIns)) {
		if (branch === "") outcome = "SNAPSHOT-WRITTEN";
		else if (
			(shown.length ? shown : [whereBefore]).every(
				(w) => w === `on branch ${branch}`,
			)
		)
			outcome = "OK";
		// Saved while still on the shown branch, then moved by Git itself
		// (an uncommitted change to a file equal on both sides carries over).
		else if (opRes && !puts.some((p) => p.s === 200 && p.t > opRes.t))
			outcome = "CARRIED";
		else outcome = "CROSSED";
	} else if (editable.length === 0 && !hasMark(edIns)) outcome = "BLOCKED";
	else if (hasMark(collisionText)) outcome = "OK-COLLISION";
	else if (hasMark(edIns) && status === "Not saved") outcome = "ERROR-SHOWN";
	else if (hasMark(edIns)) outcome = "EDITOR-ONLY";
	else outcome = "LOST";

	const rec = {
		regime: REGIME,
		case: it.case,
		i: it.i,
		offsetMs: it.offsetMs,
		outcome,
		opRefused,
		branch,
		head,
		porcelain,
		diskIns: diskIns.slice(0, 80),
		edIns: edIns.slice(0, 80),
		status,
		banners,
		collisionHasMark: hasMark(collisionText),
		opAlerts,
		opDone,
		keysTotal: keys.length,
		keysEditable: editable.length,
		keysBlockedByModal: keys.filter((k) => k.modal).length,
		keysReadOnly: keys.filter((k) => k.inEditor && k.ro).length,
		keysNotInEditor: keys.filter((k) => !k.inEditor && !k.modal).length,
		shownWhileTyping: shown,
		firstKeyRelOp: keys[0] && t0 ? keys[0].t - t0 : null,
		lastKeyRelOp: t0 && keys.length ? (keys.at(-1)?.t ?? t0) - t0 : null,
		opMs: opRes && opReq ? opRes.t - opReq.t : null,
		opStatus: opRes?.s,
		headerChangeMs: whereChange && t0 ? whereChange.t - t0 : null,
		headerAfter: whereChange?.where,
		lockChangeMs: roChange && t0 ? roChange.t - t0 : null,
		puts: puts.map((p) => ({ rel: t0 ? p.t - t0 : p.t, s: p.s, code: p.code })),
		net: it.net.map((n) => ({ ...n, t: t0 ? n.t - t0 : n.t })),
		...it.extra,
	};
	appendFileSync(LOG, `${JSON.stringify(rec)}\n`);
	return rec;
}

function reset(server: Server, target = "main") {
	try {
		git(server.paper, "merge", "--abort");
	} catch {}
	git(server.paper, "reset", "--quiet", "--hard");
	git(server.paper, "clean", "--quiet", "-fd");
	if (target.startsWith("detach:"))
		git(server.paper, "switch", "--quiet", "--detach", target.slice(7));
	else git(server.paper, "switch", "--quiet", target);
}

/** Remote branch SIDE whose main.tex is byte-identical to main's. */
async function withSide(page: Page, github: Fake, server: Server) {
	const other = coauthor(github);
	other.git("switch", "--quiet", "-c", SIDE);
	other.commitFile("side-notes.txt", "only on the side branch\n", "Side notes");
	other.remove();
	await api(page, "POST", "/git/fetch");
	git(server.paper, "branch", "--quiet", "--track", SIDE, `origin/${SIDE}`);
	expect(gitRaw(server.paper, "show", `${SIDE}:main.tex`)).toBe(
		gitRaw(server.paper, "show", "main:main.tex"),
	);
}

async function loop(name: string, body: (i: number) => Promise<void>) {
	for (let i = 0; i < N; i++) {
		try {
			await body(i);
		} catch (error) {
			appendFileSync(
				LOG,
				`${JSON.stringify({ regime: REGIME, case: name, i, outcome: "HARNESS-ERROR", error: String(error).slice(0, 400) })}\n`,
			);
			if (/has been closed|cannot change to|Test timeout/.test(String(error)))
				break;
		}
	}
}

test.beforeEach(async ({ page }) => {
	await page.context().addInitScript(instrument);
	page.on("dialog", (d) => d.accept().catch(() => {}));
});
const T = () => test.setTimeout(N * 25_000 + 90_000);

test("http: the server mechanism", async ({ page, github, server }) => {
	await openRepo(page);
	await withSide(page, github, server);
	const other = coauthor(github);
	other.git("switch", "--quiet", "-c", "differs");
	other.retitle("Different");
	other.remove();
	await api(page, "POST", "/git/fetch");
	git(
		server.paper,
		"branch",
		"--quiet",
		"--track",
		"differs",
		"origin/differs",
	);
	const get = () =>
		page.evaluate(
			async (p) =>
				(
					await fetch(p, {
						headers: {
							"X-Revisions-Token":
								document
									.querySelector('meta[name="revisions-token"]')
									?.getAttribute("content") ?? "",
						},
					})
				).headers.get("X-Revisions-Hash"),
			`${R}/file?path=main.tex`,
		);
	const text = readFileSync(join(server.paper, "main.tex"), "utf8");
	const h = await get();
	const out: Record<string, unknown> = {};
	git(server.paper, "switch", "--quiet", SIDE);
	out.identical = await api(page, "PUT", "/file?path=main.tex", {
		baseHash: h,
		text: `% crossed\n${text}`,
	});
	out.identicalBranch = git(server.paper, "branch", "--show-current");
	out.identicalDisk = readFileSync(
		join(server.paper, "main.tex"),
		"utf8",
	).startsWith("% crossed");
	reset(server, "main");
	git(server.paper, "switch", "--quiet", "differs");
	out.differs = await api(page, "PUT", "/file?path=main.tex", {
		baseHash: h,
		text: `% x\n${text}`,
	});
	reset(server, "main");
	git(server.paper, "switch", "--quiet", "--detach", "HEAD");
	out.detached = await api(page, "PUT", "/file?path=main.tex", {
		baseHash: h,
		text: `% x\n${text}`,
	});
	appendFileSync(
		join(WORK, "logs", "http-confirm.json"),
		`${JSON.stringify(out, null, 1)}\n`,
	);
});

test("switch: Branches dialog, type while it runs", async ({
	page,
	github,
	server,
}) => {
	T();
	await openRepo(page);
	await withSide(page, github, server);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("switch", async (i) => {
		reset(server);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		const p = await openPanel(page);
		await p.getByRole("button", { name: "Branch…" }).click();
		const sw = page
			.getByRole("dialog", { name: "Branches" })
			.getByRole("listitem")
			.filter({ hasText: SIDE })
			.getByRole("button", { name: "Switch" });
		await sw.waitFor();
		net.length = 0;
		const d = rand(0, 1500);
		await Promise.all([
			sw.click(),
			(async () => {
				await sleep(d);
				await typeAt(page, pt, marker(i));
			})(),
		]);
		await collect(server, {
			case: "switch",
			i,
			offsetMs: d,
			before,
			page,
			opPage: page,
			net,
			opMatch: /POST R\/git\/checkout/,
		});
	});
});

test("switch-esc: Escape closes the Branches dialog mid-switch, then type", async ({
	page,
	github,
	server,
}) => {
	T();
	await openRepo(page);
	await withSide(page, github, server);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("switch-esc", async (i) => {
		reset(server);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		const p = await openPanel(page);
		await p.getByRole("button", { name: "Branch…" }).click();
		const sw = page
			.getByRole("dialog", { name: "Branches" })
			.getByRole("listitem")
			.filter({ hasText: SIDE })
			.getByRole("button", { name: "Switch" });
		await sw.waitFor();
		net.length = 0;
		const e = rand(0, 250);
		const d = rand(0, 400);
		await Promise.all([
			sw.click({ timeout: 5000 }),
			(async () => {
				await sleep(15 + e); // after the click lands
				await page.keyboard.press("Escape");
				await sleep(d);
				await typeAt(page, pt, marker(i));
			})(),
		]);
		await collect(server, {
			case: "switch-esc",
			i,
			offsetMs: e + d,
			extra: { escMs: e },
			before,
			page,
			opPage: page,
			net,
			opMatch: /POST R\/git\/checkout/,
		});
	});
});

/** A second local commit on main, so the initial commit is an earlier version with identical main.tex. */
function laterCommit(server: Server) {
	writeFileSync(join(server.paper, "later-notes.txt"), "later\n");
	git(server.paper, "add", "later-notes.txt");
	git(server.paper, "commit", "--quiet", "-m", "Later notes");
	return git(server.paper, "rev-parse", "HEAD~1");
}

test("view: View this version, type while it runs", async ({
	page,
	server,
}) => {
	T();
	await openRepo(page);
	laterCommit(server);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("view", async (i) => {
		reset(server);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		const p = await openPanel(page);
		await p
			.getByRole("list", { name: "History" })
			.getByRole("button", { name: /Initial manuscript/ })
			.click();
		const v = p.getByRole("button", { name: "View this version" });
		await v.waitFor();
		net.length = 0;
		const d = rand(0, 1500);
		await Promise.all([
			v.click(),
			(async () => {
				await sleep(d);
				await typeAt(page, pt, marker(i));
			})(),
		]);
		await collect(server, {
			case: "view",
			i,
			offsetMs: d,
			before,
			page,
			opPage: page,
			net,
			opMatch: /POST R\/git\/checkout/,
		});
	});
});

test("back: Back to the branch from a snapshot, type while it runs", async ({
	page,
	server,
}) => {
	T();
	await openRepo(page);
	const initial = laterCommit(server);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("back", async (i) => {
		reset(server, "main");
		reset(server, `detach:${initial}`);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		const back = await returnButton(page);
		await back.waitFor();
		net.length = 0;
		const d = rand(0, 1000);
		await Promise.all([
			back.click(),
			(async () => {
				await sleep(d);
				await typeAt(page, pt, marker(i));
			})(),
		]);
		await collect(server, {
			case: "back",
			i,
			offsetMs: d,
			before,
			page,
			opPage: page,
			net,
			opMatch: /POST R\/git\/checkout/,
		});
	});
});

for (const touches of [false, true]) {
	const name = touches ? "pull-touch" : "pull-other";
	test(`${name}: Get latest, type while it runs`, async ({
		page,
		github,
		server,
	}) => {
		T();
		await openRepo(page);
		const url = page.url();
		const net: Net[] = [];
		netLog(page, "A", net);
		const other = coauthor(github);
		await loop(name, async (i) => {
			reset(server);
			if (touches) other.retitle(`Incoming ${i}`);
			else other.commitFile(`incoming-${i}.txt`, `${i}\n`, `Incoming ${i}`);
			await load(page, url);
			const before = await editorDoc(page);
			const pt = await editorPoint(page);
			const p = await openPanel(page);
			const gl = p.getByRole("button", { name: /Get latest/ });
			await expect(gl).toBeEnabled();
			net.length = 0;
			const d = rand(0, 1500);
			await Promise.all([
				gl.click(),
				(async () => {
					await sleep(d);
					await typeAt(page, pt, marker(i));
				})(),
			]);
			await collect(server, {
				case: name,
				i,
				offsetMs: d,
				before,
				page,
				opPage: page,
				net,
				opMatch: /POST R\/git\/pull/,
			});
		});
		other.remove();
	});
}

test("discard: Discard changes, type while the dialog is open or closing", async ({
	page,
	server,
}) => {
	T();
	await openRepo(page);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("discard", async (i) => {
		reset(server);
		const f = join(server.paper, "main.tex");
		writeFileSync(f, `% DISCARDME\n${readFileSync(f, "utf8")}`);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		const p = await openPanel(page);
		await p.getByRole("button", { name: /Uncommitted changes/ }).click();
		await p.getByRole("button", { name: "Discard changes…" }).click();
		const confirm = page
			.getByRole("dialog", { name: /Discard/ })
			.getByRole("button", { name: "Discard these changes" });
		await confirm.waitFor();
		net.length = 0;
		const d = rand(-500, 1200);
		await Promise.all([
			(async () => {
				await sleep(Math.max(0, -d));
				await confirm.click();
			})(),
			(async () => {
				await sleep(Math.max(0, d));
				await typeAt(page, pt, marker(i));
			})(),
		]);
		await collect(server, {
			case: "discard",
			i,
			offsetMs: d,
			before,
			page,
			opPage: page,
			net,
			opMatch: /POST R\/git\/discard$/,
			discard: true,
		});
	});
});

test("open-link: type, go Home, open a branch link at once", async ({
	page,
	github,
	server,
}) => {
	T();
	await openRepo(page);
	await withSide(page, github, server);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("open-link", async (i) => {
		reset(server);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		net.length = 0;
		const g = rand(0, 2500);
		await typeAt(page, pt, marker(i));
		await sleep(g);
		await page.locator(".topbar a.brand").click();
		await page.getByLabel("GitHub link").fill(`${PAPER.url}/tree/${SIDE}`);
		await page.getByRole("button", { name: "Open" }).click();
		await Promise.race([
			page.locator(".cm-content").waitFor({ timeout: 15_000 }),
			page.locator('[role="alert"]').first().waitFor({ timeout: 15_000 }),
		]).catch(() => {});
		await collect(server, {
			case: "open-link",
			i,
			offsetMs: g,
			before,
			page,
			opPage: page,
			net,
			opMatch: /POST \/api\/open/,
		});
	});
});

for (const op of ["switch", "view", "discard"] as const) {
	test(`two-tabs-${op}: tab A types, tab B runs ${op}`, async ({
		page,
		github,
		server,
	}) => {
		T();
		await openRepo(page);
		if (op === "switch") await withSide(page, github, server);
		if (op === "view") laterCommit(server);
		const url = page.url();
		const b = await newTab(page);
		const net: Net[] = [];
		netLog(page, "A", net);
		netLog(b, "B", net);
		await loop(`two-tabs-${op}`, async (i) => {
			reset(server);
			if (op === "discard") {
				const f = join(server.paper, "main.tex");
				writeFileSync(f, `% DISCARDME\n${readFileSync(f, "utf8")}`);
			}
			await load(page, url);
			await load(b, url);
			const before = await editorDoc(page);
			const pt = await editorPoint(page);
			const p = await openPanel(b);
			let go: Locator;
			if (op === "switch") {
				await p.getByRole("button", { name: "Branch…" }).click();
				go = b
					.getByRole("dialog", { name: "Branches" })
					.getByRole("listitem")
					.filter({ hasText: SIDE })
					.getByRole("button", { name: "Switch" });
			} else if (op === "view") {
				await p
					.getByRole("list", { name: "History" })
					.getByRole("button", { name: /Initial manuscript/ })
					.click();
				go = p.getByRole("button", { name: "View this version" });
			} else {
				await p.getByRole("button", { name: /Uncommitted changes/ }).click();
				await p.getByRole("button", { name: "Discard changes…" }).click();
				go = b
					.getByRole("dialog", { name: /Discard/ })
					.getByRole("button", { name: "Discard these changes" });
			}
			await go.waitFor();
			net.length = 0;
			const d = rand(0, 3500);
			await Promise.all([
				typeAt(page, pt, marker(i, true), 60),
				(async () => {
					await sleep(d);
					await go.click();
				})(),
			]);
			await collect(server, {
				case: `two-tabs-${op}`,
				i,
				offsetMs: d,
				before,
				page,
				opPage: b,
				net,
				opMatch:
					op === "discard"
						? /B:.*POST R\/git\/discard$|POST R\/git\/discard$/
						: op === "view"
							? /POST R\/git\/checkout/
							: /POST R\/git\/checkout/,
				discard: op === "discard",
			});
		});
		await b.close();
	});
}

test("terminal-switch: tab types, git switch runs in a terminal", async ({
	page,
	github,
	server,
}) => {
	T();
	await openRepo(page);
	await withSide(page, github, server);
	const url = page.url();
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("terminal-switch", async (i) => {
		reset(server);
		await load(page, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		net.length = 0;
		const d = rand(0, 3000);
		let sw: Record<string, unknown> = {};
		await Promise.all([
			typeAt(page, pt, marker(i, true), 60),
			(async () => {
				await sleep(d);
				const t = Date.now();
				net.push({ t, ev: "T:req", m: "TERMINAL", u: "git switch" });
				try {
					await run("git", ["-C", server.paper, "switch", "--quiet", SIDE]);
					sw = { ok: true };
				} catch (e) {
					sw = {
						ok: false,
						err: String((e as { stderr?: string }).stderr ?? e).slice(0, 200),
					};
				}
				net.push({
					t: Date.now(),
					ev: "T:res",
					m: "TERMINAL",
					u: "git switch",
					s: sw.ok ? 200 : 409,
					code: sw.ok ? undefined : "refused",
				});
			})(),
		]);
		await collect(server, {
			case: "terminal-switch",
			i,
			offsetMs: d,
			extra: { terminal: sw },
			before,
			page,
			opPage: page,
			net,
			opMatch: /TERMINAL/,
		});
	});
});

test("commit-checkout: tab types, commit then checkout back to back over HTTP", async ({
	page,
	github,
	server,
}) => {
	T();
	await openRepo(page);
	await withSide(page, github, server);
	const url = page.url();
	const b = await newTab(page);
	const net: Net[] = [];
	netLog(page, "A", net);
	await loop("commit-checkout", async (i) => {
		reset(server);
		writeFileSync(join(server.paper, `pending-${i}.txt`), "to commit\n");
		await load(page, url);
		await load(b, url);
		const before = await editorDoc(page);
		const pt = await editorPoint(page);
		net.length = 0;
		const d = rand(0, 1400);
		let calls: unknown[] = [];
		await Promise.all([
			typeAt(page, pt, marker(i, true), 60),
			(async () => {
				await sleep(d);
				net.push({
					t: Date.now(),
					ev: "B:req",
					m: "POST",
					u: "COMMIT+CHECKOUT",
				});
				const c = await api(b, "POST", "/git/commit", {
					message: `Commit ${i}`,
				});
				const k = await api(b, "POST", "/git/checkout", { branch: SIDE });
				calls = [
					{ commit: c.status, body: c.status >= 400 ? c.body : "" },
					{
						checkout: k.status,
						body: k.status >= 400 ? k.body : "",
						gapMs: k.t0 - c.t1,
					},
				];
				net.push({
					t: Date.now(),
					ev: "B:res",
					m: "POST",
					u: "COMMIT+CHECKOUT",
					s: k.status,
					code: k.status >= 400 ? "checkout-refused" : undefined,
				});
			})(),
		]);
		const committed = git(
			server.paper,
			"show",
			"--stat",
			"--format=",
			"main",
		).includes("main.tex");
		await collect(server, {
			case: "commit-checkout",
			i,
			offsetMs: d,
			extra: { calls, typedTextCommittedOnMain: committed },
			before,
			page,
			opPage: b,
			net,
			opMatch: /COMMIT\+CHECKOUT/,
		});
	});
	await b.close();
});

// What a person sees after the two bad end states, reproduced directly.
test("followup: aftermath of SNAPSHOT-WRITTEN and ERROR-SHOWN", async ({
	page,
	server,
}) => {
	test.setTimeout(120_000);
	await openRepo(page);
	const initial = laterCommit(server);
	const url = page.url();
	const out: Record<string, unknown> = {};
	const alerts = async () =>
		(await page.locator('[role="alert"]').allTextContents())
			.filter((s) => !s.includes("settings could not"))
			.map((s) => s.slice(0, 220));

	// 1. A snapshot holding an uncommitted change (what a late save carried by git switch --detach leaves).
	const f = join(server.paper, "main.tex");
	writeFileSync(f, `QJCARRIED\n${readFileSync(f, "utf8")}`);
	git(server.paper, "switch", "--quiet", "--detach", initial);
	out.snapshotPorcelain = git(server.paper, "status", "--porcelain");
	await load(page, url);
	out.snapshotEditorHasText = (await editorDoc(page)).includes("QJCARRIED");
	out.snapshotSaveStatus = await page.locator(".save-status").textContent();
	const p = await openPanel(page);
	out.panelButton = await page
		.getByRole("button", { name: /Changes & history/ })
		.textContent();
	await (await returnButton(page)).click();
	await sleep(1500);
	out.backAlerts = await alerts();
	out.branchAfterBack = git(server.paper, "branch", "--show-current");
	await p.getByRole("button", { name: /Uncommitted changes/ }).click();
	const cb = p.getByRole("button", { name: "Commit", exact: true });
	out.commitButton = {
		disabled: await cb.isDisabled(),
		title: await cb.getAttribute("title"),
	};
	out.discardOffered = await p
		.getByRole("button", { name: "Discard changes…" })
		.isVisible();

	// 2. ERROR-SHOWN: text refused as detached, then Return to main, then one more key.
	reset(server, "main");
	await load(page, url);
	await typeAt(page, await editorPoint(page), "QJERR");
	git(server.paper, "switch", "--quiet", "--detach", initial); // before the 1 s autosave
	await sleep(3500);
	out.errStatus = await page.locator(".save-status").textContent();
	out.errBanners = (await page.locator(".banner.danger").allTextContents()).map(
		(s) => s.slice(0, 200),
	);
	out.errEditorHasText = (await editorDoc(page)).includes("QJERR");
	await (await returnButton(page)).click();
	await sleep(3000);
	out.afterBackStatus = await page.locator(".save-status").textContent();
	out.afterBackDiskHasText = readFileSync(f, "utf8").includes("QJERR");
	await typeAt(page, await editorPoint(page), "Z");
	await sleep(2500);
	out.afterKeyStatus = await page.locator(".save-status").textContent();
	out.afterKeyDiskHasText = readFileSync(f, "utf8").includes("QJERR");
	out.afterKeyBranch = git(server.paper, "branch", "--show-current");
	writeFileSync(
		join(WORK, "logs", "followup.json"),
		JSON.stringify(out, null, 1),
	);
});
