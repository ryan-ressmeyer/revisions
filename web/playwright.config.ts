import { defineConfig } from "@playwright/test";

// The tests run against the real binary and a GitHub fake, which
// e2e/fixtures.ts starts. Run `make e2e`, which builds bin/revisions first;
// global-setup.ts builds the fake.
export default defineConfig({
	testDir: "e2e",
	globalSetup: "./e2e/global-setup.ts",
	forbidOnly: !!process.env.CI,
	reporter: "list",
	use: { channel: "chrome", trace: "retain-on-failure" },
});
