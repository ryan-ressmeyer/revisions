import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/client";
import { explain, failure } from "./errors";
import { issueUrl, lastProblem } from "./feedback";

const about = {
	version: "v0.3.0",
	env: {
		platform: "darwin" as const,
		git: { found: true, version: "2.47.1" },
		latexmk: { found: false, version: "" },
		synctex: { found: false },
	},
	browser: "Mozilla/5.0 Test",
};

const params = (url: string) => new URL(url).searchParams;

describe("issueUrl", () => {
	test("opens the form for the kind on the public repository, with the environment filled in", () => {
		const url = issueUrl("idea", about, "");
		expect(
			url.startsWith("https://github.com/ryan-ressmeyer/revisions/issues/new?"),
		).toBe(true);
		const p = params(url);
		expect(p.get("template")).toBe("idea.yml");
		expect(p.get("environment")).toBe(
			"Revisions v0.3.0\nPlatform: darwin\nGit: 2.47.1\nlatexmk: not found\nBrowser: Mozilla/5.0 Test",
		);
		expect(p.has("problem")).toBe(false);
	});

	test("a problem report carries the failure, cut to fit a URL", () => {
		expect(
			params(issueUrl("bug", about, "internal: boom")).get("problem"),
		).toBe("internal: boom");
		const long =
			params(issueUrl("bug", about, "x".repeat(10_000))).get("problem") ?? "";
		expect(long.length).toBeLessThanOrEqual(2000);
		expect(long.endsWith("…")).toBe(true);
	});

	test("only the problem form carries the failure", () => {
		expect(
			params(issueUrl("confusing", about, "internal: boom")).has("problem"),
		).toBe(false);
	});

	test("every kind has an issue form with the fields Revisions fills in", () => {
		for (const [kind, ids] of [
			["bug", ["problem", "environment"]],
			["idea", ["environment"]],
			["confusing", ["environment"]],
		] as const) {
			const form = readFileSync(
				new URL(`../../../.github/ISSUE_TEMPLATE/${kind}.yml`, import.meta.url),
				"utf8",
			);
			for (const id of ids) expect(form).toContain(`id: ${id}\n`);
		}
	});

	test("works before the environment is known", () => {
		const p = params(
			issueUrl("bug", { version: "", env: null, browser: "B" }, ""),
		);
		expect(p.get("environment")).toBe("Revisions unknown\nBrowser: B");
	});
});

describe("last problem", () => {
	test("unexpected failures are kept; refusals the user can act on are not", () => {
		explain(new ApiError(500, "internal", "boom", {}));
		expect(lastProblem()).toBe("internal: boom");
		explain(new ApiError(409, "dirty", "uncommitted", {}));
		expect(lastProblem()).toBe("internal: boom");
		failure(
			new ApiError(502, "git_failed", "Git reported a problem: fatal: x", {}),
		);
		expect(lastProblem()).toBe("git_failed: Git reported a problem: fatal: x");
		explain(new ApiError(502, "host_failed", "GitHub said no", {}));
		expect(lastProblem()).toBe("host_failed: GitHub said no");
		explain(new ApiError(500, "unknown", "The server answered 500.", {}));
		expect(lastProblem()).toBe("unknown: The server answered 500.");
		explain(new TypeError("Failed to fetch"));
		expect(lastProblem()).toBe("TypeError: Failed to fetch");
	});
});
