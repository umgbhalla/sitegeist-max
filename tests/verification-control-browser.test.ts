import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { buildVerification } from "../scripts/build-verification.mjs";

test("control appears during page loading and reconnects after extension reload without refreshing the challenge", { timeout: 30_000 }, async (t) => {
	const extension = await mkdtemp(join(tmpdir(), "jev-control-"));
	await buildVerification(extension, { apiKey: "control-test-key", baseUrl: "https://api.typesafe.ai", model: "jev-test", autoStart: false });
	const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
	assert.equal(manifest.content_scripts[0].run_at, "document_start");
	let mainRequests = 0;
	const blocked: (() => void)[] = [];
	const server = createServer((req, res) => {
		res.setHeader("Content-Type", "text/html");
		if (req.url === "/slow.js") {
			blocked.push(() => res.end(""));
			return;
		}
		if (req.url === "/") {
			mainRequests++;
			res.end('<!doctype html><head><script src="/slow.js"></script></head><body>Test page</body>');
		} else res.end("<!doctype html><body>Challenge frame</body>");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const context = await chromium.launchPersistentContext("", {
		channel: "chromium", headless: true, viewport: { width: 900, height: 700 },
		args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--silent-debugger-extension-api"],
	});
	try {
		let calls = 0;
		await context.route("https://api.typesafe.ai/**", async (route) => { calls++; await route.abort(); });
		const page = await context.newPage();
		await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "commit" });
		const timeOrigin = await page.evaluate(() => {
			const frame = document.createElement("iframe");
			frame.id = "tcaptcha_iframe_dy";
			frame.src = "/frame";
			frame.style.cssText = "position:fixed;left:20px;top:20px;width:360px;height:360px;border:0";
			document.documentElement.dataset.insertedAt = String(performance.now());
			document.documentElement.append(frame);
			return performance.timeOrigin;
		});
		const button = page.getByRole("button", { name: "Complete verification", exact: true });
		await button.waitFor({ state: "visible", timeout: 1_000 });
		const timing = await page.evaluate(() => ({ readyState: document.readyState, ms: performance.now() - Number(document.documentElement.dataset.insertedAt) }));
		t.diagnostic(`Button appeared in ${Math.round(timing.ms)} ms while readyState=${timing.readyState}`);
		assert.equal(timing.readyState, "loading", "Button must not wait for DOMContentLoaded or page load");
		assert.ok(timing.ms < 1_000);
		assert.equal(calls, 0);
		for (const release of blocked.splice(0)) release();
		await page.waitForLoadState("domcontentloaded");

		// CSSOM mutations do not generate MutationObserver records.
		await page.evaluate(() => {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync("#tcaptcha_iframe_dy { opacity: 0 !important; }");
			document.adoptedStyleSheets = [sheet];
		});
		await button.waitFor({ state: "hidden", timeout: 1_000 });
		const cssStart = performance.now();
		await page.evaluate(() => document.adoptedStyleSheets[0].deleteRule(0));
		await button.waitFor({ state: "visible", timeout: 1_000 });
		const cssMs = performance.now() - cssStart;
		t.diagnostic(`CSS-only reveal detected in ${Math.round(cssMs)} ms`);
		assert.ok(cssMs < 1_000);
		assert.equal(calls, 0);
		const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
		const inject = async (target: typeof worker) => target.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
			if (tab.id === undefined) throw new Error("No test tab");
			await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
		});
		await inject(worker);
		await inject(worker);
		t.diagnostic("Repeated injection kept one control");
		assert.equal(await page.locator("#jev-verification-control").count(), 1);
		const old = await page.locator("#jev-verification-control").elementHandle();
		assert.ok(old);
		const management = await context.newPage();
		await management.goto("chrome://extensions/");
		const developerMode = management.getByRole("button", { name: "Developer mode", exact: true });
		if (await developerMode.getAttribute("aria-pressed") !== "true") await developerMode.click();
		const nextWorkerPromise = context.waitForEvent("serviceworker", { timeout: 5_000 });
		await management.getByRole("button", { name: "Reload", exact: true }).click();
		const nextWorker = await nextWorkerPromise;
		t.diagnostic("Extension worker restarted");
		await page.bringToFront();
		await page.waitForFunction((oldControl) => !oldControl?.isConnected || oldControl.id !== "jev-verification-control", old);
		await button.waitFor({ state: "visible", timeout: 2_000 });
		assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin);
		assert.equal(mainRequests, 1, "Reconnecting must not refresh the page or challenge");
		assert.equal(await page.locator("#jev-verification-control").count(), 1);
		assert.equal(calls, 0);

		// Emulate the reported missing runtime without using any privileged API.
		await page.addScriptTag({ content: await readFile(join(extension, "content.js"), "utf8") });
		await button.click();
		await page.getByRole("status").filter({ hasText: "Extension connection lost" }).waitFor();
		assert.equal(await page.getByRole("button", { name: "Reload page to reconnect" }).isDisabled(), true);
		assert.equal(calls, 0);
		await inject(nextWorker);
		await button.click();
		await page.getByRole("button", { name: "Try current challenge once" }).waitFor();
		const result = JSON.parse(await page.locator("#jev-verification-control pre").textContent() || "null");
		assert.equal(result.ok, false);
		assert.equal(result.phase, "verification", "A fresh control must reach the extension background");
		assert.doesNotMatch(result.error, /sendMessage|context invalidated/i);
		assert.equal(calls, 0, "Unsupported test frame must not start model calls");
		await page.evaluate(() => {
			document.dispatchEvent(new Event("jev-verification:replace-control"));
			const legacy = document.createElement("div");
			legacy.id = "jev-verification-control";
			legacy.textContent = "Old control";
			document.documentElement.append(legacy);
			new MutationObserver(() => { if (!legacy.isConnected) document.documentElement.append(legacy); })
				.observe(document.documentElement, { childList: true, subtree: true });
		});
		await inject(nextWorker);
		await button.waitFor({ state: "visible" });
		assert.equal(await page.locator("#jev-verification-control").count(), 1);
		assert.equal(await page.locator("#jev-verification-retired-control").isVisible(), false);
		await page.evaluate(() => document.querySelector("#tcaptcha_iframe_dy")?.remove());
		await inject(nextWorker);
		await page.getByRole("button",{name:"Export latest 20 runs"}).waitFor({state:"hidden"});
		await nextWorker.evaluate(async () => {
			const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
			if (tab.id === undefined) throw new Error("No test tab");
			await chrome.tabs.sendMessage(tab.id,{type:"jev-verification:show-recordings"}).catch(()=>undefined);
		});
		await page.getByRole("button",{name:"Export latest 20 runs"}).waitFor({state:"visible"});
		assert.equal(await page.getByRole("button",{name:"Complete verification",exact:true}).isVisible(),false);
		assert.equal(calls,0);
		t.diagnostic("Saved-history export is accessible without a visible challenge");

	} finally {
		for (const release of blocked.splice(0)) release();
		await context.close();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(extension, { recursive: true, force: true });
	}
});
