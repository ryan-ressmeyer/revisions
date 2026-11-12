import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Builds the GitHub fake once for the whole run. Workers inherit the
// environment variable that names it.
export default function globalSetup() {
	const dir = mkdtempSync(join(tmpdir(), "revisions-githubfake-"));
	const binary = join(
		dir,
		process.platform === "win32" ? "githubfake.exe" : "githubfake",
	);
	execFileSync(
		"go",
		["build", "-o", binary, "./internal/host/githubfake/cmd/githubfake"],
		{ cwd: resolve(import.meta.dirname, "../.."), stdio: "inherit" },
	);
	process.env.REVISIONS_E2E_GITHUBFAKE = binary;
}
