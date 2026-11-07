import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

interface Fixture {
	id: string;
	width: number;
	height: number;
	pixels: string;
}

test("extension analyzes and completes a cross-origin mock challenge", { timeout: 30_000 }, async (testContext) => {
	const fixtures: Fixture[] = JSON.parse(await readFile(new URL("./verification-image-fixtures.json", import.meta.url), "utf8"));
	const fixture = fixtures.find((item) => item.id === "37313");
	assert.ok(fixture);
	const mask = inflateSync(Buffer.from(fixture.pixels, "base64")).toString("base64");
	const extension = await mkdtemp(join(tmpdir(), "sitegeist-verification-"));
	await writeFile(join(extension, "manifest.json"), JSON.stringify({
		manifest_version: 3, name: "Verification test", version: "1.0",
		permissions: ["tabs", "scripting", "debugger"], host_permissions: ["<all_urls>"],
	}));
	await writeFile(join(extension, "index.html"), '<script src="bundle.js"></script>');
	await writeFile(join(extension, "typesafe.local.json"), JSON.stringify({ apiKey: "isolated-test-key", baseUrl: "https://api.typesafe.ai", model: "jev-test" }));
	await build({
		stdin: {
			contents: 'import { VerificationShapeTool } from "./src/tools/verification/verification-tool.ts"; window.VerificationShapeTool = VerificationShapeTool;',
			resolveDir: resolve(import.meta.dirname, ".."),
		},
		outfile: join(extension, "bundle.js"), bundle: true, platform: "browser", format: "iife", define: { __TYPESAFE_ENABLED__: "true" },
	});
	const child = `<!doctype html><html><body style="margin:0"><div id="tcWrap"><div id="instructionWrap"><div id="instruction"><span id="instructionText">Select in order:</span></div></div><div id="slideBg" style="width:544px;height:389px;position:relative"></div><div class="tc-action verify-btn" style="width:80px;height:30px;background:blue;color:white">OK</div><div class="tc-success" style="display:none"><span id="statusSuccess">Verification passed</span></div></div><script>
	const bytes=Uint8Array.from(atob('${mask}'),c=>c.charCodeAt(0));const canvas=document.createElement('canvas');canvas.width=${fixture.width};canvas.height=${fixture.height};const ctx=canvas.getContext('2d');const img=ctx.createImageData(canvas.width,canvas.height);for(let i=0;i<bytes.length;i++){let v=bytes[i]?0:255;img.data.set([v,v,v,255],i*4)}ctx.putImageData(img,0,0);
	const crop=(x,y,w,h)=>{let c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(canvas,x,y,w,h,0,0,w,h);return c.toDataURL()};for(let i=0;i<3;i++){let el=document.createElement('div');el.className='tc-instruction-icon';el.style.cssText='display:inline-block;width:46px;height:41px;background-image:url('+crop(273+46*i,88,46,41)+')';document.querySelector('#instruction').append(el)}document.querySelector('#slideBg').style.backgroundImage='url('+crop(60,137,544,389)+')';document.body.dataset.ready='1';
	let count=0;const expected=[[485,162],[486,227],[97,289]];document.querySelector('#slideBg').onclick=e=>{const [x,y]=expected[count]||[-100,-100];if(Math.hypot(e.offsetX-x,e.offsetY-y)>20)return;let n=document.createElement('div');n.className='tc-click-mark';n.style.cssText='position:absolute;left:'+e.offsetX+'px;top:'+e.offsetY+'px;width:10px;height:10px;background:blue';n.textContent=String(++count);e.currentTarget.append(n)};document.querySelector('.verify-btn').onclick=()=>{if(count===3)document.querySelector('.tc-success').style.display='block'};
	</script></body></html>`;
	const server = createServer((req, res) => {
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
			args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--silent-debugger-extension-api"],
		});
		const extensionPage = await context.newPage();
		const management = await context.newPage();
		await management.goto("chrome://extensions/");
		const ids = await management.evaluate(() => {
			const manager = document.querySelector("extensions-manager")?.shadowRoot;
			const list = manager?.querySelector("extensions-item-list")?.shadowRoot;
			return Array.from(list?.querySelectorAll("extensions-item") || [], (item) => item.id);
		});
		assert.equal(ids.length, 1);
		await extensionPage.goto(`chrome-extension://${ids[0]}/index.html`);
		let target = await context.newPage();
		await target.goto(`http://127.0.0.1:${address.port}/`);
		await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
		await target.bringToFront();
		const attempt = (method: "shape" | "jev" = "shape") => extensionPage.evaluate(async (method) => {
			const win = await chrome.windows.getCurrent();
			const { VerificationShapeTool } = window as unknown as { VerificationShapeTool: new () => { windowId?: number; execute(id: string, args: { count: number; attempt: boolean; method: "shape" | "jev" }): Promise<{ details: { interaction?: { status: string; acknowledged: number; submissionAttempted: boolean; reason?: string }; jev?: { stages: unknown[]; matches: { selected: number; refinement?: { status: string; before: { selected: number } } }[] } } }> } };
			const tool = new VerificationShapeTool();
			tool.windowId = win.id;
			return tool.execute("test", { count: 3, attempt: true, method });
		}, method);
		const start = performance.now();
		const result = await attempt();
		testContext.diagnostic(`Mock challenge attempt took ${Math.round(performance.now() - start)} ms`);
		assert.equal(result.details.interaction?.status, "success");
		assert.equal(result.details.interaction?.acknowledged, 3);
		assert.equal(result.details.interaction?.submissionAttempted, true);

		await target.reload();
		const frameBody = target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]');
		await frameBody.waitFor();
		await frameBody.evaluate(() => {
			setTimeout(() => {
				const scene = document.querySelector<HTMLElement>("#slideBg");
				if (scene) scene.style.filter = "brightness(0.5)";
			}, 500);
		});
		const stale = await attempt();
		assert.ok(["changed", "uncertain"].includes(stale.details.interaction?.status || ""));
		assert.equal(stale.details.interaction?.acknowledged, 0);
		assert.equal(stale.details.interaction?.submissionAttempted, false);
		assert.equal(await target.frameLocator("#tcaptcha_iframe_dy").locator(".tc-click-mark").count(), 0);

		let apiCalls = 0;
		let rejectApi = false;
		let forceRefinement = false;
		let chooseNeither = false;
		await context.route("https://api.typesafe.ai/v1/systemone", async (route) => {
			apiCalls++;
			assert.equal(route.request().headers().authorization, "Bearer isolated-test-key");
			assert.equal(route.request().headers()["typesafe-danger-zone-images"], "true");
			if (rejectApi) {
				await route.fulfill({ status: 429, contentType: "application/json", body: "{}" });
				return;
			}
			const body = route.request().postDataBuffer(); assert.ok(body);
			const request = new Request("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { "content-type": route.request().headers()["content-type"] }, body: new Uint8Array(body) });
			const form = await request.formData();
			const json = form.get("request"); assert.ok(json instanceof Blob);
			const payload: { questions: Record<string, { type: string; criteria?: Record<string, string> }> } = JSON.parse(await json.text());
			for (const [name, image] of form) {
				if (name === "request") continue;
				assert.ok(image instanceof Blob);
				const bytes = Buffer.from(await image.arrayBuffer());
				assert.ok(bytes.readUInt32BE(16) >= 280 && bytes.readUInt32BE(16) <= 1568);
				assert.ok(bytes.readUInt32BE(20) >= 280 && bytes.readUInt32BE(20) <= 1568);
			}
			const answers: Record<string, unknown> = {};
			for (const [id, question] of Object.entries(payload.questions)) {
				if (question.type === "noul") answers[id] = { type: "noul", noul: id === "match_b" ? 0.99 : id === "match" ? (forceRefinement ? 0.2 : 0.99) : 0.01 };
				else {
					const options = Object.keys(question.criteria ?? {});
					const selected = options.includes("neither") ? (chooseNeither ? "neither" : "b") : id.startsWith("region_") ? `r${[1, 3, 2][Number(id.slice(7))]}` : forceRefinement ? "c1" : "c0";
					answers[id] = { type: "choice", choice: selected, probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 0.99 : 0.01 / (options.length - 1)])) };
				}
			}
			await route.fulfill({ contentType: "application/json", body: JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 20 } }) });
		});
		await target.reload();
		await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
		// Use a fresh target after the prior native debugger session. Headless
		// Chrome can otherwise retain a one-pixel compositor resize on reload.
		await target.close();
		target = await context.newPage();
		await target.goto(`http://127.0.0.1:${address.port}/`);
		await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
		const jevStart = performance.now();
		const jev = await attempt("jev");
		testContext.diagnostic(`Mock Jev pipeline plus native input took ${Math.round(performance.now() - jevStart)} ms`);
		assert.equal(jev.details.interaction?.status, "success");
		assert.equal(jev.details.interaction?.acknowledged, 3);
		assert.equal(jev.details.jev?.stages.length, 7);
		assert.equal(apiCalls, 7);

		await target.reload();
		await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
		forceRefinement = true;
		await target.screenshot();
		const refined = await attempt("jev");
		assert.equal(refined.details.interaction?.status, "success");
		assert.equal(refined.details.interaction?.acknowledged, 3);
		assert.equal(refined.details.jev?.matches.length, 3);
		assert.ok(refined.details.jev?.matches.every((match) => match.refinement?.status === "accepted"));
		assert.ok(refined.details.jev?.matches.every((match) => match.selected === 0 && match.refinement?.before.selected === 1));
		assert.equal(refined.details.jev?.stages.length, 10);
		assert.equal(apiCalls, 17);

		await target.reload();
		await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
		chooseNeither = true;
		await target.screenshot();
		const unresolved = await attempt("jev");
		assert.equal(unresolved.details.interaction?.acknowledged, 0);
		assert.equal(unresolved.details.interaction?.submissionAttempted, false);
		assert.equal(unresolved.details.jev?.matches.length, 3, JSON.stringify(unresolved.details.interaction));
		assert.ok(unresolved.details.jev?.matches.every((match) => match.refinement?.status === "unresolved"));
		assert.equal(apiCalls, 27);
		assert.equal(await target.frameLocator("#tcaptcha_iframe_dy").locator(".tc-click-mark").count(), 0);
		await target.reload();
		await target.frameLocator("#tcaptcha_iframe_dy").locator('body[data-ready="1"]').waitFor();
		rejectApi = true;
		const limited = await attempt("jev");
		assert.equal(limited.details.interaction?.acknowledged, 0);
		assert.equal(limited.details.interaction?.submissionAttempted, false);
		assert.match(limited.details.interaction?.reason ?? "", /HTTP 429/);
		assert.equal(apiCalls, 28);
		assert.equal(await target.frameLocator("#tcaptcha_iframe_dy").locator(".tc-click-mark").count(), 0);
	} finally {
		await context?.close();
		server.close();
		await rm(extension, { recursive: true, force: true });
	}
});
