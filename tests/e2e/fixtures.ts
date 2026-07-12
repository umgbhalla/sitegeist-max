import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, test as base } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../dist-chrome");

// Provider hosts the mock must NEVER reach. Aborting them is a loud tripwire:
// if a test hits one, the in-process LLM mock missed a construction site.
const PROVIDER_HOSTS = [
	"**://api.anthropic.com/**",
	"**://api.openai.com/**",
	"**://*.googleapis.com/**",
	"**://*.githubcopilot.com/**",
];

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
	context: async ({}, use) => {
		const context = await chromium.launchPersistentContext("", {
			channel: "chromium", // REQUIRED to load an unpacked extension (incl. new headless)
			headless: !!process.env.CI,
			args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
		});
		for (const h of PROVIDER_HOSTS) {
			await context.route(h, (r) => r.abort());
		}
		await use(context);
		await context.close();
	},
	extensionId: async ({ context }, use) => {
		let [sw] = context.serviceWorkers();
		if (!sw) sw = await context.waitForEvent("serviceworker");
		await use(new URL(sw.url()).host);
	},
});

export const expect = test.expect;

// Build the sidepanel URL with a scripted mock plan + test-driver steps.
// `teststeps` short-circuits initApp (sidepanel.ts) BEFORE any welcome/permission
// dialog, creating a throwaway session and sending each step via the real agent loop.
export function sidepanelUrl(
	extensionId: string,
	opts: { steps: string[]; mock: Array<{ text?: string; tool?: { name: string; args?: Record<string, unknown> } }> },
): string {
	const teststeps = encodeURIComponent(JSON.stringify(opts.steps));
	const mockresponses = encodeURIComponent(JSON.stringify(opts.mock));
	return `chrome-extension://${extensionId}/sidepanel.html?teststeps=${teststeps}&mockresponses=${mockresponses}`;
}
