import { expect, test } from "vitest";
import { branchChoices, refChips } from "./refs";

test("a branch that sits at the same commit here and on GitHub is one chip", () => {
	expect(
		refChips(["HEAD", "refs/heads/main", "refs/remotes/origin/main"], "main"),
	).toEqual({
		detached: false,
		chips: [{ name: "main", where: "both", current: true }],
	});
});

test("local and remote branches that differ get their own chips, current first", () => {
	expect(
		refChips(
			[
				"refs/remotes/origin/draft",
				"refs/heads/notes",
				"HEAD",
				"refs/heads/main",
				"refs/remotes/upstream/main",
			],
			"main",
		),
	).toEqual({
		detached: false,
		chips: [
			{ name: "main", where: "local", current: true },
			{ name: "draft", where: "remote", current: false },
			{ name: "notes", where: "local", current: false },
			{ name: "upstream/main", where: "remote", current: false },
		],
	});
});

test("HEAD without a branch is a detached snapshot", () => {
	expect(refChips(["HEAD", "refs/remotes/origin/main"], null)).toEqual({
		detached: true,
		chips: [{ name: "main", where: "remote", current: false }],
	});
	expect(refChips(["refs/heads/main"], null).detached).toBe(false);
});

test("branch choices merge local and origin branches and ignore other remotes", () => {
	expect(
		branchChoices([
			{ refs: ["HEAD", "refs/heads/main", "refs/remotes/origin/main"] },
			{ refs: ["refs/remotes/origin/feature/a", "refs/remotes/pull/3"] },
			{ refs: ["refs/heads/draft"] },
		]),
	).toEqual([
		{ name: "draft", local: true, remote: false },
		{ name: "feature/a", local: false, remote: true },
		{ name: "main", local: true, remote: true },
	]);
});
