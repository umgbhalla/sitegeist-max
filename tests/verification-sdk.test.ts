import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { buildVerificationSdk } from "../scripts/build-verification-sdk.mjs";
import { VerificationClient, VerificationCompletionError, VERIFICATION_BUDGET } from "../src/verification-sdk/index.js";

test("SDK clients share the window lock and release it after cancellation", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
	let queries = 0;
	Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
		tabs: { query: async () => { queries++; return [{ id: 7 }]; } },
	} });
	let resolveConfig: (() => void) | undefined;
	const configReady = new Promise<void>((resolve) => { resolveConfig = resolve; });
	const controller = new AbortController();
	const client = new VerificationClient({ loadConfig: async () => {
		await configReady;
		return { apiKey: "sdk-test-only", baseUrl: "https://api.typesafe.ai", model: "jev-test" };
	} });
	try {
		const first = client.verify({ windowId: 1, signal: controller.signal });
		const stopped = assert.rejects(first, (error: unknown) => {
			assert.ok(error instanceof VerificationCompletionError);
			assert.equal(error.message, "SDK caller cancelled");
			assert.equal(error.budget.limitMs, 300_000);
			return true;
		});
		await assert.rejects(new VerificationClient().verify({ windowId: 1 }), /already running/);
		controller.abort(new Error("SDK caller cancelled"));
		resolveConfig?.();
		await stopped;
		await assert.rejects(new VerificationClient({ loadConfig: async () => undefined }).verify({ windowId: 1 }), /not configured/);
		assert.equal(queries, 2);
	} finally {
		resolveConfig?.();
		if (previous) Object.defineProperty(globalThis, "chrome", previous);
		else Reflect.deleteProperty(globalThis, "chrome");
	}
});

test("SDK rejects an already cancelled call before browser or configuration access", async () => {
	let calls = 0;
	const client = new VerificationClient({ loadConfig: async () => { calls++; return undefined; } });
	await assert.rejects(client.verify({ windowId: 1, signal: AbortSignal.abort(new Error("Cancelled before start")) }), /Cancelled before start/);
	assert.equal(calls, 0);
	assert.equal(VERIFICATION_BUDGET.limitMs, 300_000);
});

test("SDK distribution imports independently and its declarations typecheck a consumer", async () => {
	const output = await mkdtemp(join(tmpdir(), "verification-sdk-"));
	try {
		await buildVerificationSdk(output);
		const metadata = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
		assert.equal(metadata.name, "@sitegeist/verification-sdk");
		assert.equal(metadata.exports["."].types, "./index.d.ts");
		assert.equal(metadata.dependencies, undefined);
		await writeFile(join(output, "smoke.mjs"), `import { VerificationClient, VERIFICATION_BUDGET } from './index.js';
const client = new VerificationClient({loadConfig: async () => undefined});
await client.verify({windowId: 1, signal: AbortSignal.abort(new Error('consumer cancel'))}).then(() => {throw new Error('Cancellation was ignored')}, error => {if(error.message !== 'consumer cancel') throw error});
console.log(JSON.stringify({client: typeof client.verify, limitMs: VERIFICATION_BUDGET.limitMs}));\n`);
		const smoke = JSON.parse(execFileSync(process.execPath, [join(output, "smoke.mjs")], { encoding: "utf8" }));
		assert.deepEqual(smoke, { client: "function", limitMs: 300_000 });
		await writeFile(join(output, "consumer.ts"), `import { VerificationClient, type VerificationRequest, type VerificationDetails } from './index.js';
const client = new VerificationClient({loadConfig: async () => ({apiKey:'consumer-test',baseUrl:'https://api.typesafe.ai',model:'jev-latest'})});
const request: VerificationRequest = {windowId: 1, tabId: 7, attempt: false};
const result: Promise<VerificationDetails> = client.verify(request);
void result;\n`);
		await writeFile(join(output, "tsconfig.consumer.json"), JSON.stringify({ compilerOptions: {
			module: "NodeNext", target: "ES2022", strict: true, noEmit: true, types: [], lib: ["ES2022", "DOM"],
		}, files: ["consumer.ts"] }));
		execFileSync("tsc", ["--project", join(output, "tsconfig.consumer.json")], { env: {
			...process.env,
			PATH: [resolve("node_modules/.bin"), resolve("../mini-lit/node_modules/.bin"), process.env.PATH].filter(Boolean).join(delimiter),
		}, stdio: "pipe" });
	} finally {
		await rm(output, { recursive: true, force: true });
	}
});
