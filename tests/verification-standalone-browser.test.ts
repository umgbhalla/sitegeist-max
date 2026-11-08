import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { chromium, type Worker } from "@playwright/test";
import { buildVerification } from "../scripts/build-verification.mjs";
import type { TelemetryRun, VerificationDetails } from "../src/verification-sdk/index.js";

test("standalone page button completes exactly one low-confidence Jev attempt", { timeout: process.env.JEV_TEST_LONG_TIMEOUT === "1" ? 360_000 : 90_000 }, async (t) => {
	const fixtures: { id: string; width: number; height: number; pixels: string }[] = JSON.parse(await readFile(new URL("./verification-image-fixtures.json", import.meta.url), "utf8"));
	const fixture = fixtures.find((item) => item.id === "37313");
	assert.ok(fixture);
	const mask = inflateSync(Buffer.from(fixture.pixels, "base64")).toString("base64");
	const extension = await mkdtemp(join(tmpdir(), "jev-standalone-"));
	await buildVerification(extension, { apiKey: "standalone-test-key", baseUrl: "https://api.typesafe.ai", model: "jev-test" });
	const child = `<!doctype html><html><body style="margin:0"><div id="tcWrap" data-session="private-attribute-value"><input type="hidden" value="private-hidden-value"><div id="instructionWrap"><div id="instruction"><span id="instructionText">Select in order:</span></div></div><div id="slideBg" style="width:544px;height:389px;position:relative"></div><div class="tc-action verify-btn" style="width:80px;height:30px;background:blue;color:white">OK</div><div class="tc-success" style="display:none"><span id="statusSuccess">Verification passed</span></div></div><script>
	const bytes=Uint8Array.from(atob('${mask}'),c=>c.charCodeAt(0));const canvas=document.createElement('canvas');canvas.width=${fixture.width};canvas.height=${fixture.height};const ctx=canvas.getContext('2d');const img=ctx.createImageData(canvas.width,canvas.height);for(let i=0;i<bytes.length;i++){let v=bytes[i]?0:255;img.data.set([v,v,v,255],i*4)}ctx.putImageData(img,0,0);
	const crop=(x,y,w,h)=>{let c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);return c.toDataURL()};for(let i=0;i<3;i++){let el=document.createElement('div');el.className='tc-instruction-icon';el.style.cssText='display:inline-block;width:46px;height:41px;background-image:url('+crop(273+46*i,88,46,41)+')';document.querySelector('#instruction').append(el)}document.querySelector('#slideBg').style.backgroundImage='url('+crop(60,137,544,389)+')';document.body.dataset.ready='1';
	let count=0;const expected=[[485,162],[486,227],[97,289]];document.querySelector('#slideBg').onclick=e=>{const [x,y]=expected[count]||[-100,-100];if(Math.hypot(e.offsetX-x,e.offsetY-y)>20)return;let n=document.createElement('div');n.className='tc-click-mark';n.style.cssText='position:absolute;left:'+e.offsetX+'px;top:'+e.offsetY+'px;width:10px;height:10px;background:blue';n.textContent=String(++count);e.currentTarget.append(n)};document.querySelector('.verify-btn').onclick=()=>{if(count===3)document.querySelector('.tc-success').style.display='block'};
	</script><script>globalThis.privateCredential="standalone-test-key";</script><script src="/telemetry-fixture.js"></script><script src="/telemetry-fixture.js?session=private-query-value"></script></body></html>`;
	const server = createServer((req, res) => {
		if (req.url?.startsWith("/telemetry-fixture.js")) { res.setHeader("Content-Type", "application/javascript"); res.end('globalThis.externalTelemetryFixture = {token:"private-script-token"};'); return; }
		res.setHeader("Content-Type", "text/html");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Server address unavailable");
		res.end(req.url === "/frame" ? child : `<!doctype html><iframe id="tcaptcha_iframe_dy" src="http://localhost:${address.port}/frame" style="position:fixed;left:20px;top:20px;width:600px;height:500px;border:0"></iframe>`);
	});
	await new Promise<void>((done) => server.listen(0, "::", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Server address unavailable");
	let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
	try {
		context = await chromium.launchPersistentContext("", {
			channel: "chromium", headless: true, viewport: { width: 900, height: 700 }, deviceScaleFactor: 1.6,
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...(process.env.JEV_TEST_DEBUGGER_BANNER === "1" ? [] : ["--silent-debugger-extension-api"])],
		});
		let calls = 0;
		let branch = false;
		let reject = false;
		let gridDelayMs = 0;
		await context.route("https://api.typesafe.ai/v1/systemone", async (route) => {
			calls++;
			assert.equal(route.request().headers().authorization, "Bearer standalone-test-key");
			if (reject) { await route.fulfill({ status: 429, body: "{}" }); return; }
			const bytes = route.request().postDataBuffer(); assert.ok(bytes);
			const request = new Request("https://api.typesafe.ai", { method: "POST", headers: { "content-type": route.request().headers()["content-type"] }, body: new Uint8Array(bytes) });
			const form = await request.formData();
			const part = form.get("request"); assert.ok(part instanceof Blob);
			const payload: { questions: Record<string, { type: string; criteria?: Record<string, string> }> } = JSON.parse(await part.text());
			if (Object.keys(payload.questions).some((id) => id.startsWith("region_")) && gridDelayMs)
				await new Promise((resolve) => setTimeout(resolve, gridDelayMs));
			const answers: Record<string, unknown> = {};
			for (const [id, question] of Object.entries(payload.questions)) {
				if (question.type === "noul") { answers[id] = { type: "noul", noul: 0.01 }; continue; }
				const options = Object.keys(question.criteria ?? {});
				const selected = id.startsWith("region_") ? `r${[1,3,2][Number(id.slice(7))]}` : (branch && id === "pick" && options.length === 5 ? "c1" : "c0");
				answers[id] = { type: "choice", choice: selected, probabilities: Object.fromEntries(options.map((option) => [option, 1 / options.length])) };
			}
			await route.fulfill({ contentType: "application/json", body: JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 10, output_tokens: 10 } }) }).catch(() => undefined);
		});
		const target = await context.newPage();
		const open = async (suffix = "") => {
			await target.goto(`http://127.0.0.1:${address.port}/${suffix}`);
			await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
			await target.bringToFront();
			await target.getByRole("button", { name: "Complete verification", exact: true }).waitFor();
			await target.screenshot();
		};
		const run = async () => {
			await target.getByRole("button", { name: "Complete verification", exact: true }).click();
			await target.getByRole("button", { name: "Try current challenge once" }).waitFor({ timeout: 305_000 });
			const text = await target.locator("#jev-verification-control pre").textContent();
			assert.ok(text, await target.getByRole("status").textContent() || "No result");
			return JSON.parse(text) as VerificationDetails;
		};
		await open();
		await target.waitForTimeout(250);
		assert.equal(calls, 0, "Detection alone must never invoke Jev or click");
		await target.getByRole("button", { name: "Complete verification", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
		await target.waitForTimeout(100);
		assert.equal(calls, 0, "Synthetic page clicks must not trigger an attempt");
		const initialWorker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
		await initialWorker.evaluate(() => chrome.storage.local.set({ automaticExport: true }));
		const first = await run();
		let automaticFile: string | undefined;
		for (let poll = 0; poll < 50; poll++) {
			const downloads = await initialWorker.evaluate(() => chrome.downloads.search({}));
			if (downloads[0]?.state === "complete") { automaticFile = downloads[0].filename; break; }
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(automaticFile, "Successful run was not automatically exported");
		const automaticExport = JSON.parse(await readFile(automaticFile, "utf8")) as { runs: TelemetryRun[] };
		assert.equal(automaticExport.runs[0]?.id, first.telemetry?.runId);
		assert.equal(automaticExport.runs[0]?.status, "success");
		await initialWorker.evaluate(() => chrome.storage.local.set({ automaticExport: false }));
		t.diagnostic(`Standalone service worker + native clicks took ${first.elapsedMs} ms`);
		assert.equal(first.interaction?.status, "success", JSON.stringify(first));
		assert.equal(first.interaction?.acknowledged, 3);
		assert.equal(first.interaction?.submissionAttempted, true);
		assert.equal(first.jev?.thresholds, null);
		assert.equal(first.telemetry?.stored, true);
		assert.ok((first.telemetry?.assetCount ?? 0) > 20);
		assert.equal(first.budget?.version, "jev-2026-11-08.4");
		assert.equal(first.budget?.targetMs, 10_000);
		assert.equal(first.budget?.limitMs, 300_000);
		assert.ok(first.jev?.matches.every((match) => match.accepted && match.choice <= 0.25 && match.match === 0.01));
		assert.ok((first.elapsedMs ?? Infinity) < 10_000);
		assert.equal(calls, 4);
		await target.waitForTimeout(1_000);
		assert.equal(calls, 4, "No automatic retry after completion");
		await open();
		const cached = await run();
		assert.equal(cached.interaction?.status, "success");
		assert.equal(calls, 4, "Exact current image/questions should reuse cached responses");
		assert.ok(cached.jev?.stages.every((stage) => stage.model === "local" || stage.cache === "hit"));
		assert.ok(cached.jev?.stages.every((stage) => stage.usage.input_tokens === 0 && stage.usage.output_tokens === 0));

		await target.waitForTimeout(1_000);
		// Different pixels force fresh responses; model disagreement gets one closer comparison.
		branch = true;
		await open();
		await target.frameLocator("#tcaptcha_iframe_dy").locator("#slideBg").evaluate((scene: HTMLElement) => { scene.style.filter = "brightness(0.98)"; });
		await target.screenshot();
		const branched = await run();
		assert.equal(branched.interaction?.status, "success");
		assert.ok(branched.jev?.matches.every((match) => match.decision?.strategy === "aligned-comparison"));
		assert.ok(branched.jev?.matches.every((match) => match.decision?.initial === 1 && match.selected === 0));
		assert.equal(calls, 11);

		await target.waitForTimeout(1_000);
		reject = true;
		await open();
		await target.frameLocator("#tcaptcha_iframe_dy").locator("#slideBg").evaluate((scene: HTMLElement) => { scene.style.filter = "brightness(0.96)"; });
		const failed = await run();
		assert.equal(failed.interaction?.status, "uncertain");
		assert.equal(failed.interaction?.acknowledged, 0);
		assert.equal(failed.interaction?.submissionAttempted, false);
		assert.equal(calls, 12);
		assert.equal(await target.frameLocator("#tcaptcha_iframe_dy").locator(".tc-click-mark").count(), 0);

		reject = false;
		branch = false;
		gridDelayMs = 0;
		await open();
		await target.frameLocator("#tcaptcha_iframe_dy").locator("#instruction").evaluate(async (instruction: HTMLElement) => {
			const icons = Array.from(instruction.querySelectorAll<HTMLElement>(".tc-instruction-icon"));
			const stripCanvas = document.createElement("canvas");
			stripCanvas.width = 138;
			stripCanvas.height = 41;
			const context = stripCanvas.getContext("2d");
			if (!context) throw new Error("No test canvas");
			for (let index = 0; index < icons.length; index++) {
				const image = new Image();
				image.src = getComputedStyle(icons[index]).backgroundImage.slice(5, -2);
				await image.decode();
				context.drawImage(image, index * 46, 0);
			}
			const strip = document.createElement("div");
			strip.className = "tc-instruction-icon";
			strip.style.cssText = `display:inline-block;width:138px;height:41px;background-image:url(${stripCanvas.toDataURL()})`;
			icons[0].replaceWith(strip);
			for (const icon of icons.slice(1)) icon.remove();
		});
		const composite = await run();
		assert.equal(composite.interaction?.status, "success", JSON.stringify(composite));
		assert.equal(composite.referenceCount, 3);
		assert.deepEqual(composite.referenceLayout, { source: "combined-strip", elementCount: 1 });
		assert.equal(composite.rankings.length, 3);
		assert.equal(composite.jev?.matches.length, 3);
		assert.equal(composite.interaction?.acknowledged, 3);
		assert.equal(composite.interaction?.submissionAttempted, true);
		assert.equal(composite.interaction?.status, "success", JSON.stringify(composite));
		assert.equal(composite.interaction?.events?.filter((event) => event.event === "input_dispatched").length, 3);
		assert.equal(composite.interaction?.events?.filter((event) => event.event === "submission_dispatched").length, 1);

		reject = false;
		branch = false;
		gridDelayMs = 11_000;
		await open();
		await target.frameLocator("#tcaptcha_iframe_dy").locator("#slideBg").evaluate((scene: HTMLElement) => { scene.style.filter = "brightness(0.97)"; });
		const delayed = await run();
		t.diagnostic(`Delayed-grid attempt: ${delayed.elapsedMs} ms; ${delayed.interaction?.status}`);
		assert.equal(delayed.interaction?.status, "success", JSON.stringify(delayed));
		assert.ok((delayed.jev?.stages.find((stage) => stage.stage === "grid")?.ms ?? 0) >= 10_500);
		assert.ok((delayed.elapsedMs ?? 0) > 10_000);
		assert.ok((delayed.elapsedMs ?? Infinity) < 300_000);
		assert.equal(delayed.budget?.targetExceeded, true);
		assert.equal(delayed.interaction?.acknowledged, 3);
		assert.equal(delayed.interaction?.submissionAttempted, true);
		const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
		const mockDownload = (worker: Worker) => worker.evaluate(() => {
			chrome.downloads.download = async (options) => {
				(globalThis as typeof globalThis & { telemetryDownload?: string }).telemetryDownload = options.url;
				return 71;
			};
		});
		await mockDownload(worker);
		await target.getByText("Attempt details", { exact: true }).click();
		await target.getByLabel("Observed verification result").selectOption("failure");
		await target.getByLabel("Calibration note").fill("Second target needs review");
		await target.getByRole("button", { name: "Save observed result" }).click();
		await target.getByRole("status").filter({ hasText: "Observed result saved" }).waitFor();
		await target.getByRole("button", { name: "Export this run with images" }).click();
		await target.getByRole("status").filter({ hasText: "dataset download started" }).waitFor();
		const readDownload = (source: Worker = worker) => source.evaluate(() => {
			const url = (globalThis as typeof globalThis & { telemetryDownload?: string }).telemetryDownload;
			if (!url) throw new Error("No calibration download");
			const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (character) => character.charCodeAt(0));
			return JSON.parse(new TextDecoder().decode(bytes));
		});
		const single = await readDownload() as { runs: TelemetryRun[]; assets: { mime: string; data: string; sha256: string; bytes: number }[] };
		assert.equal(single.runs.length, 1);
		assert.equal(single.runs[0].id, delayed.telemetry?.runId);
		assert.equal(single.runs[0].label?.outcome, "failure");
		assert.equal(single.runs[0].status, "success", "Manual ground truth stays separate from automatic outcome");
		assert.ok(single.runs[0].assets.some((asset) => asset.role === "after/frame.png"));
		assert.ok(single.runs[0].assets.some((asset) => asset.role === "script-source.js"));
		assert.ok(single.runs[0].events.some((event) => event.name === "jev_request"));
		assert.ok(single.runs[0].events.some((event) => event.name === "image_geometry"));
		const allText = JSON.stringify(single.runs) + single.assets.filter((asset) => !asset.mime.startsWith("image/")).map((asset) => Buffer.from(asset.data, "base64").toString("utf8")).join("\n");
		for (const secret of ["standalone-test-key", "private-hidden-value", "private-attribute-value", "private-query-value", "private-script-token"])
			assert.equal(allText.includes(secret), false, `Redaction failed for ${secret}`);
		assert.ok(single.assets.some((asset) => asset.mime === "image/png"));
		await target.getByRole("button", { name: "Export latest 20 runs" }).click();
		await target.getByRole("status").filter({ hasText: "dataset download started" }).waitFor();
		await target.waitForTimeout(100);
		const batch = await readDownload() as { runs: TelemetryRun[] };
		assert.ok(batch.runs.length >= 6);
		assert.ok(batch.runs.some((run) => run.status === "uncertain"));
		t.diagnostic(`Calibration export: ${batch.runs.length} runs; single run has ${single.assets.length} unique assets`);
		const oldControl = await target.locator("#jev-verification-control").elementHandle();
		const documentTime = await target.evaluate(() => performance.timeOrigin);
		const management = await context.newPage();
		await management.goto("chrome://extensions/");
		const developerMode = management.getByRole("button", {name:"Developer mode",exact:true});
		if (await developerMode.getAttribute("aria-pressed") !== "true") await developerMode.click();
		const restarted = context.waitForEvent("serviceworker", {timeout:5000});
		await management.getByRole("button", {name:"Reload",exact:true}).click();
		const restartedWorker = await restarted;
		await management.close();
		await target.bringToFront();
		await target.waitForFunction(old => !old?.isConnected || old.id !== "jev-verification-control", oldControl);
		await mockDownload(restartedWorker);
		await target.getByRole("button",{name:"Export latest 20 runs"}).click();
		await target.getByRole("status").filter({hasText:"dataset download started"}).waitFor();
		const persisted = await readDownload(restartedWorker) as {runs:TelemetryRun[]};
		assert.equal(persisted.runs.length,batch.runs.length);
		assert.equal(persisted.runs.find(run=>run.id===delayed.telemetry?.runId)?.label?.outcome,"failure");
		assert.equal(await target.evaluate(()=>performance.timeOrigin),documentTime);
		t.diagnostic("Images and user labels survived extension reload without refreshing the challenge");

		// The five-minute wall-clock replay remains available without slowing every SDK check.
		if (process.env.JEV_TEST_LONG_TIMEOUT === "1") {
			const beforeTimeout = calls;
			await open();
			gridDelayMs = 301_000;
			await target.frameLocator("#tcaptcha_iframe_dy").locator("#slideBg").evaluate((scene: HTMLElement) => { scene.style.filter = "brightness(0.94)"; });
			const expired = await run();
			assert.equal(expired.interaction?.status, "uncertain");
			assert.equal(expired.interaction?.acknowledged, 0);
			assert.equal(expired.interaction?.submissionAttempted, false);
			assert.match(expired.jev?.stages[0]?.error ?? "", /recognition budget/);
			assert.ok((expired.jev?.stages[0]?.ms ?? 0) > 297_000);
			assert.ok((expired.elapsedMs ?? Infinity) < 300_000);
			assert.equal(expired.budget?.targetExceeded, true);
			assert.equal(expired.budget?.limitMs, 300_000);
			await target.waitForTimeout(1_000);
			assert.equal(calls, beforeTimeout + 1, "Timed-out requests must not retry");
			assert.equal(await target.frameLocator("#tcaptcha_iframe_dy").locator(".tc-click-mark").count(), 0);
		}

	} finally {
		await context?.close();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(extension, { recursive: true, force: true });
	}
});
