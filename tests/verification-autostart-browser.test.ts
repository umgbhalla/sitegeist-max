import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { buildVerification } from "../scripts/build-verification.mjs";

test("a visible challenge starts one attempt without a click and does not retry", { timeout: 45_000 }, async (t) => {
	const extension = await mkdtemp(join(tmpdir(), "jev-auto-"));
	await buildVerification(extension, {
		apiKey: "auto-test-key",
		baseUrl: "https://api.typesafe.ai",
		model: "jev-test",
	});
	const server = createServer((req, res) => {
		res.setHeader("Content-Type", "text/html");
		res.end(req.url === "/" ? "<!doctype html><body>Auto start page</body>" : "<!doctype html><body>Challenge frame</body>");
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const context = await chromium.launchPersistentContext("", {
		channel: "chromium",
		headless: true,
		viewport: { width: 900, height: 700 },
		args: [
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
			"--silent-debugger-extension-api",
		],
	});
	try {
		let calls = 0;
		await context.route("https://api.typesafe.ai/**", async (route) => {
			calls++;
			await route.abort();
		});
		const page = await context.newPage();
		await page.goto(`http://127.0.0.1:${address.port}/`);
		await page.bringToFront();
		// Give the page focus without touching the verification control.
		await page.locator("body").click();
		const autoButton = page.getByRole("button", { name: "Complete verification", exact: true });
		const insertedAt = performance.now();
		await page.evaluate(() => {
			const frame = document.createElement("iframe");
			frame.id = "tcaptcha_iframe_dy";
			frame.src = "/frame";
			frame.style.cssText = "position:fixed;left:20px;top:20px;width:360px;height:360px;border:0";
			document.documentElement.append(frame);
		});
		await autoButton.waitFor({ state: "visible", timeout: 1_000 });
		const status = page.getByRole("status");
		await status.filter({ hasText: "Automatic attempt failed" }).waitFor({ timeout: 20_000 });
		const autoMs = Math.round(performance.now() - insertedAt);
		const text = (await status.textContent()) ?? "";
		assert.match(text, /Use the button to try this challenge once/);
		assert.equal(await page.getByRole("button", { name: "Try current challenge once" }).isVisible(), true);
		const firstReport = (await page.locator("#jev-verification-control pre").textContent()) ?? "";
		const parsed = JSON.parse(firstReport);
		t.diagnostic(`Automatic attempt finished in ${autoMs} ms with phase=${parsed.phase}: ${parsed.error}`);
		assert.equal(parsed.phase, "verification", "The no-click attempt must reach the shared verification SDK");
		assert.match(parsed.error, /Could not uniquely locate/);
		assert.equal(calls, 0, "The unsupported test frame must fail before model calls");
		await page.waitForTimeout(4_000);
		const repeats = (await page.locator("#jev-verification-control pre").textContent()) ?? "";
		assert.equal(repeats, firstReport, "Failure must not trigger a second automatic attempt");
		assert.equal(await status.filter({ hasText: "Automatic attempt failed" }).isVisible(), true);
	} finally {
		await context.close();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(extension, { recursive: true, force: true });
	}
});
