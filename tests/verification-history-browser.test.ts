import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { buildVerification } from "../scripts/build-verification.mjs";
import type { TelemetryRun } from "../src/verification-sdk/telemetry-store.js";

test("standalone history switches persist and an error run automatically downloads", { timeout: 30_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "verification-history-"));
	const extension = join(root, "extension");
	const server = createServer((_request, response) => response.end("<!doctype html><title>Fixture</title>"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
	try {
		await buildVerification(extension, { apiKey: "test-fixture-key", baseUrl: "https://example.com", model: "fixture" });
		context = await chromium.launchPersistentContext(join(root, "profile"), {
			channel: "chromium", headless: true, acceptDownloads: true,
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
		});
		const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
		const history = await context.newPage();
		await history.goto(`chrome-extension://${new URL(worker.url()).host}/history.html`);
		await history.getByText("No recordings yet.").waitFor();
		await history.locator("#enabled").uncheck();
		await history.waitForTimeout(100);
		await history.reload();
		assert.equal(await history.locator("#enabled").isChecked(), false);
		await history.locator("#enabled").check();
		await history.locator("#auto").check();
		await history.waitForTimeout(100);
		await history.reload();
		assert.equal(await history.locator("#auto").isChecked(), true);
		const target = await context.newPage();
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture server address");
		await target.goto(`http://127.0.0.1:${address.port}/`);
		await worker.evaluate("globalThis.__name = (value) => value");
		const result = await worker.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			if (tab.id === undefined) throw new Error("No active tab");
			const [execution] = await chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => chrome.runtime.sendMessage({ type: "jev-verification:complete" }),
			});
			return execution.result as { ok: boolean; telemetry?: { runId: string; stored: boolean } };
		});
		assert.equal(result.ok, false);
		assert.equal(result.telemetry?.stored, true);
		let filename: string | undefined;
		for (let poll = 0; poll < 50; poll++) {
			const downloads = await worker.evaluate(() => chrome.downloads.search({}));
			if (downloads[0]?.state === "complete") { filename = downloads[0].filename; break; }
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(filename, "Automatic download did not complete");
		const exported = JSON.parse(await readFile(filename, "utf8")) as { runs: TelemetryRun[] };
		assert.equal(exported.runs.length, 1);
		assert.equal(exported.runs[0].id, result.telemetry?.runId);
		assert.equal(exported.runs[0].status, "error");
		await history.getByRole("button", { name: "Refresh" }).click();
		await history.getByText(result.telemetry.runId, { exact: false }).waitFor();
		await history.getByText("Activity and coverage").click();
		await history.getByText("Coverage:", { exact: false }).waitFor();
		const localDate = await history.evaluate(() => {
			const now = new Date();
			return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		});
		await history.locator("#start").fill(localDate);
		await history.locator("#end").fill(localDate);
		await history.getByRole("button", { name: "Export range" }).click();
		await history.getByText("Export started.").waitFor();
		let rangeFile: string | undefined;
		for (let poll = 0; poll < 50; poll++) {
			const downloads = await worker.evaluate(() => chrome.downloads.search({}));
			if (downloads.length >= 2 && downloads[0].state === "complete") { rangeFile = downloads[0].filename; break; }
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(rangeFile, "Range download did not complete");
		const ranged = JSON.parse(await readFile(rangeFile, "utf8")) as { runs: TelemetryRun[] };
		assert.deepEqual(ranged.runs.map((run) => run.id), [result.telemetry.runId]);

		await history.locator("#enabled").uncheck();
		await history.waitForTimeout(100);
		await target.bringToFront();
		const disabled = await worker.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			if (tab.id === undefined) throw new Error("No active tab");
			const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => chrome.runtime.sendMessage({ type: "jev-verification:complete" }) });
			return execution.result as { telemetry?: unknown };
		});
		assert.equal(disabled.telemetry, undefined);
		await history.getByRole("button", { name: "Refresh" }).click();
		assert.equal(await history.locator("#runs article").count(), 1);
		await history.locator("#enabled").check();
		await history.waitForTimeout(100);
		await worker.evaluate("chrome.downloads.download = async () => { throw new Error('simulated download failure') }");
		await target.bringToFront();
		const failedExport = await worker.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
			if (tab.id === undefined) throw new Error("No active tab");
			const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => chrome.runtime.sendMessage({ type: "jev-verification:complete" }) });
			return execution.result as { telemetry?: { warnings: string[] } };
		});
		assert.ok(failedExport.telemetry?.warnings.some((warning) => warning.includes("simulated download failure")));
		await history.getByRole("button", { name: "Refresh" }).click();
		await history.getByText("Automatic export failed: simulated download failure").waitFor();
		history.once("dialog", (dialog) => { void dialog.accept(); });
		await history.getByRole("button", { name: "Delete all" }).click();
		await history.getByText("No recordings yet.").waitFor();

	} finally {
		await context?.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
