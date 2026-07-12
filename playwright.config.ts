import { defineConfig } from "@playwright/test";

// MV3 extensions require a persistent context (see tests/e2e/fixtures.ts), which
// locks the user-data dir -> single worker. Headless is decided in the fixture
// (channel:'chromium' supports the new headless mode); config.use.headless does
// NOT apply to manually-launched persistent contexts.
export default defineConfig({
	testDir: "tests/e2e",
	workers: 1,
	fullyParallel: false,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	reporter: "list",
});
