import { expect, test } from "./fixtures.js";

test("captures a web tab without an activeTab gesture", async ({ context, extensionId }) => {
	const worker = context.serviceWorkers().find((worker) => new URL(worker.url()).host === extensionId);
	if (!worker) throw new Error("Extension service worker not found");
	const page = await context.newPage();
	await page.route("https://example.com/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>Screenshot permission check</h1>" }),
	);
	await page.goto("https://example.com/");
	await page.bringToFront();
	const screenshot = await worker.evaluate(async () => {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		if (!tab) throw new Error("Active tab not found");
		return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
	});
	expect(screenshot).toMatch(/^data:image\/png;base64,iVBOR/);
});
