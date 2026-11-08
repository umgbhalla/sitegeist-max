import assert from "node:assert/strict";
import { test } from "node:test";
import { VisionResponseCache } from "../src/verification-sdk/response-cache.js";

const config = { apiKey: "isolated-key", baseUrl: "https://api.typesafe.ai", model: "jev-test" };
const questions = { pick: { type: "choice" as const, instructions: "Which?", criteria: { a: "A", b: "B" } } };
const response = { model: "jev-test", answers: { pick: { type: "choice", choice: "a", probabilities: { a: 0.5, b: 0.5 } } }, usage: {} };

test("response cache uses exact image/question/model/account inputs and deduplicates in-flight requests", async () => {
	const original = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => {
		requests++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		return Response.json(response);
	};
	try {
		const cache = new VisionResponseCache();
		const images = { scene: new Blob(["scene-1"]) };
		const ask = (nextImages = images, nextQuestions = questions, nextConfig = config) => cache.ask(nextConfig, nextImages, nextQuestions, performance.now() + 2_000);
		const parallel = await Promise.all([ask(), ask()]);
		assert.equal(requests, 1);
		assert.deepEqual(parallel.map((result) => result.cache).sort(), ["miss", "shared"]);
		parallel[0].response.answers.pick.choice = "b";
		const hit = await ask();
		assert.equal(hit.cache, "hit");
		assert.equal(hit.response.answers.pick.choice, "a", "Caller mutations must not poison the cached response");
		await ask({ scene: new Blob(["scene-2"]) });
		await ask(images, { pick: { ...questions.pick, instructions: "Different question" } });
		await ask(images, questions, { ...config, model: "different-model" });
		await ask(images, questions, { ...config, apiKey: "different-account" });
		assert.equal(requests, 5);
		cache.clear();
		assert.equal((await ask()).cache, "miss");
		assert.equal(requests, 6);
	} finally {
		globalThis.fetch = original;
	}
});

test("failed and expired calls cannot become cached successes", async () => {
	const original = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => { requests++; return new Response("{}", { status: 429 }); };
	try {
		const cache = new VisionResponseCache();
		const ask = () => cache.ask(config, {}, questions, performance.now() + 2_000);
		await assert.rejects(ask, /429/);
		await assert.rejects(ask, /429/);
		assert.equal(requests, 2);
		await assert.rejects(cache.ask(config, {}, questions, performance.now() - 1), /deadline/);
		await assert.rejects(cache.ask(config, {}, questions, performance.now() + 2_000, AbortSignal.abort()));
		assert.equal(requests, 2);
	} finally {
		globalThis.fetch = original;
	}
});
