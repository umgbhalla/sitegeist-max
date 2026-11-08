import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import type { VerificationClient, VerificationTelemetryStore } from "../src/verification-sdk/index.js";
import type { VerificationTelemetryRecorder } from "../src/verification-sdk/telemetry.js";
import { redactTelemetryText, sanitizeTelemetry } from "../src/verification-sdk/telemetry-redaction.js";

test("telemetry redacts named credentials and URL queries while retaining model usage", () => {
	const text = redactTelemetryText('const apiKey="private-key"; const token="private-token"; const session_id="private-session"; https://example.com/path?ticket=private-query#private-fragment apikey_1234567890abcdef', ["private-key"]);
	for (const value of ["private-key", "private-token", "private-session", "private-query", "private-fragment", "apikey_1234567890abcdef"])
		assert.equal(text.includes(value), false, text);
	assert.deepEqual(sanitizeTelemetry({ authorization: "Bearer private", input_tokens: 123, output_tokens: 22, url: "https://example.com/path?secret=x" }), {
		authorization: "[redacted]", input_tokens: 123, output_tokens: 22, url: "https://example.com/path",
	});
	assert.equal(redactTelemetryText('url("/image?ticket=private-css"); const src="/path?session=private-relative";').includes("private-"), false);
});

test("telemetry persists analysis, errors and checkpoints; labels, deduplication and retention survive a new client", { timeout: 30_000 }, async () => {
	const browser = await chromium.launch();
	const output = await mkdtemp(join(tmpdir(), "verification-telemetry-"));
	try {
		const page = await browser.newPage();
		await page.route("http://localhost:9827/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
		await page.goto("http://localhost:9827/");
		const bundle = await build({ stdin: {
			contents: 'import { VerificationClient, VerificationTelemetryStore } from "./src/verification-sdk/index.ts"; import { VerificationTelemetryRecorder } from "./src/verification-sdk/telemetry.ts"; window.TestTelemetry = { VerificationClient, VerificationTelemetryStore, VerificationTelemetryRecorder };',
			resolveDir: resolve(import.meta.dirname, ".."),
		}, bundle: true, platform: "browser", format: "iife", write: false });
		await page.addScriptTag({ content: "globalThis.__name = (value) => value;\n" + bundle.outputFiles[0].text });
		const dataset = await page.evaluate(async () => {
			const sdk = (window as unknown as { TestTelemetry: {
				VerificationClient: typeof VerificationClient;
				VerificationTelemetryStore: typeof VerificationTelemetryStore;
				VerificationTelemetryRecorder: typeof VerificationTelemetryRecorder;
			} }).TestTelemetry;
			const store = new sdk.VerificationTelemetryStore();
			await store.clearRuns();
			const recorder = new sdk.VerificationTelemetryRecorder(store, { attempt: false });
			recorder.protect("private-runtime-key");
			recorder.text("sample.js", 'const token="private-token"; const x="private-runtime-key";', "text/javascript");
			recorder.event("image_geometry", { scale: { x: 1.6, y: 1.6 } });
			const saved = await recorder.finish({ method: "shape" });
			if (!saved.stored) throw new Error("Analysis record was not saved");
			const cancelled = new sdk.VerificationClient();
			await cancelled.verify({ windowId: 1, signal: AbortSignal.abort(new Error("cancelled-fixture")) }).then(() => { throw new Error("Cancellation ignored"); }, () => undefined);
			let exported = JSON.parse(await (await store.exportRuns()).text());
			if (!exported.runs.some((run: { status: string }) => run.status === "error")) throw new Error("Error run missing");
			if (!exported.runs.some((run: { status: string }) => run.status === "analysis")) throw new Error("Analysis run missing");
			const previousChrome = Object.getOwnPropertyDescriptor(window, "chrome");
			const scene = document.createElement("canvas");
			scene.width = innerWidth; scene.height = innerHeight;
			const context = scene.getContext("2d");
			if (!context) throw new Error("No test image context");
			context.fillStyle = "white"; context.fillRect(0, 0, scene.width, scene.height);
			Object.defineProperty(window, "chrome", { configurable: true, value: {
				tabs: { query: async () => [{ id: 7 }], captureVisibleTab: async () => scene.toDataURL() },
				scripting: { executeScript: async ({func}: {func: () => unknown}) => [{result:func()}] },
			} });
			try {
				const unavailable = new sdk.VerificationClient();
				unavailable.telemetry.saveRun = async () => { throw new Error("Simulated local quota failure"); };
				const analysis = await unavailable.verify({windowId:1,method:"shape",attempt:false,count:1,reference:{x:0,y:0,width:10,height:10},scene:{x:20,y:0,width:100,height:100}});
				if (analysis.method !== "shape" || analysis.telemetry?.stored !== false || !analysis.telemetry.warnings.some(message => message.includes("quota"))) throw new Error("Recording failure affected analysis or was hidden");
			} finally {
				if (previousChrome) Object.defineProperty(window,"chrome",previousChrome);
				else Reflect.deleteProperty(window,"chrome");
			}
			const pending = new sdk.VerificationTelemetryRecorder(store, { attempt: true });
			pending.text("checkpoint.txt", "checkpoint evidence", "text/plain");
			pending.checkpoint();
			for (let poll = 0; poll < 100; poll++) {
				exported = JSON.parse(await (await new sdk.VerificationTelemetryStore().exportRuns()).text());
				if (exported.runs.some((run: { id: string; status: string; assets: unknown[] }) => run.id === pending.run.id && run.status === "running" && run.assets.length === 1)) break;
				await new Promise((done) => setTimeout(done, 10));
			}
			if (!exported.runs.some((run: { id: string; status: string; assets: unknown[] }) => run.id === pending.run.id && run.status === "running" && run.assets.length === 1)) throw new Error("Checkpoint did not survive a new store client");
			await store.clearRuns();
			for (let index = 0; index < 52; index++) {
				const run = new sdk.VerificationTelemetryRecorder(store, { attempt: false, index });
				run.run.startedAt = new Date(1_700_000_000_000 + index * 1000).toISOString();
				run.text("same.txt", "same content across all runs", "text/plain");
				await run.finish({ method: "shape" });
			}
			const summaries = await new sdk.VerificationTelemetryStore().listRuns(50);
			if (summaries.length !== 50) throw new Error("Retention limit was not applied");
			await store.labelRun(summaries[0].id, { outcome: "failure", notes: "User observed an incorrect second target" });
			const result = JSON.parse(await (await store.exportRuns()).text());
			if (result.runs.length !== 20 || result.assets.length !== 1) throw new Error("Batch size or asset deduplication failed");
			if (result.runs[0].label?.outcome !== "failure" || result.runs[0].status !== "analysis") throw new Error("User label and automatic outcome were not kept separate");
			const withoutLabel = {...result.runs[0],label:undefined};
			await store.saveRun(withoutLabel,[]);
			if ((await store.listRuns())[0].label?.outcome !== "failure") throw new Error("A checkpoint overwrote a human label");
			return result;
		});
		const input = join(output, "dataset.json");
		await writeFile(input, JSON.stringify(dataset));
		const receipt = JSON.parse(execFileSync(process.execPath, ["scripts/unpack-verification-telemetry.mjs", input, join(output, "unpacked")], { encoding: "utf8" }));
		assert.equal(receipt.runs, 20);
		assert.equal(receipt.assets, 1);
		assert.equal(receipt.verified, true);
		const index = JSON.parse(await readFile(join(output, "unpacked/index.json"), "utf8"));
		assert.equal(index.runs[0].label.outcome, "failure");
		dataset.assets[0].data = btoa("corrupt content");
		await writeFile(input, JSON.stringify(dataset));
		assert.throws(() => execFileSync(process.execPath, ["scripts/unpack-verification-telemetry.mjs", input, join(output, "corrupt")], { stdio: "pipe" }));
	} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }
});
