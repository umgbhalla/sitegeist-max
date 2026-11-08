import assert from "node:assert/strict";
import { test } from "node:test";
import { askTypesafe, parseVisionResponse, type VisionQuestion } from "../src/verification-sdk/typesafe-client.js";
import { acceptMatch, completeCandidates, gridRegions, searchRegion } from "../src/verification-sdk/typesafe-recognition.js";

const questions: Record<string, VisionQuestion> = {
	pick: { type: "choice", instructions: "Which matches?", criteria: { c0: "first", c1: "second" } },
	match: { type: "noul", instructions: "Does the selected crop match?" },
};
const response = () => ({ model: "jev-test", answers: {
	pick: { type: "choice", choice: "c0", probabilities: { c0: 0.97, c1: 0.03 } },
	match: { type: "noul", noul: 0.95 },
}, usage: { input_tokens: 100, output_tokens: 20 } });

test("Jev output rejects missing, inconsistent, and non-finite remote probabilities", () => {
	assert.equal(parseVisionResponse(response(), questions).answers.pick.choice, "c0");
	assert.throws(() => parseVisionResponse({ ...response(), answers: {} }, questions));
	for (const value of [Number.NaN, -1, 2]) {
		const bad = response(); bad.answers.match.noul = value;
		assert.throws(() => parseVisionResponse(bad, questions));
	}
	const wrong = response(); wrong.answers.pick.choice = "c1";
	assert.throws(() => parseVisionResponse(wrong, questions));
	const unnormalized = response(); unnormalized.answers.pick.probabilities.c1 = 0.9;
	assert.throws(() => parseVisionResponse(unnormalized, questions));
});

test("grid uncertainty broadens search and overlap retains boundary targets", () => {
	const scene = { x: 50, y: 100, width: 600, height: 400 };
	const regions = gridRegions(scene);
	assert.ok(regions[0].x + regions[0].width > regions[1].x);
	assert.ok(regions[0].y + regions[0].height > regions[2].y);
	assert.deepEqual(searchRegion({ type: "choice", probabilities: { r0: 0.4, r1: 0.3, r2: 0.2, r3: 0.1 } }, regions, scene), scene);
	assert.deepEqual(searchRegion({ type: "choice", probabilities: { r0: 0.98, r1: 0.01, r2: 0.01, r3: 0 } }, regions, scene), regions[0]);
	const expanded = searchRegion({ type: "choice", probabilities: { r0: 0.8, r1: 0.15, r2: 0.04, r3: 0.01 } }, regions, scene);
	assert.equal(expanded.width, scene.width);
});

test("attempt gates allow moderate evidence but reject absent targets and unresolved ties", () => {
	const clear = { shapeScore: 0.99, shapeMargin: 0.1, choice: 0.99, runnerUp: 0.01, match: 0.95, alternativeMatch: 0.03 };
	assert.equal(acceptMatch(clear), true);
	for (const change of [{ match: 0.2 }, { choice: 0.4 }, { shapeScore: 0.5 }, { match: Number.NaN }, { match: 0.4, alternativeMatch: 0.9 }]) assert.equal(acceptMatch({ ...clear, ...change }), false);
	assert.equal(acceptMatch({ ...clear, shapeScore: 0.87, shapeMargin: 0.03 }), true);
	assert.equal(acceptMatch({ ...clear, shapeScore: 0.72, shapeMargin: 0, choice: 0.58, runnerUp: 0.42, match: 0.48, alternativeMatch: 0.52 }), true);
	assert.equal(acceptMatch({ ...clear, choice: 0.6, runnerUp: 0.55 }), true);
	assert.equal(acceptMatch({ ...clear, choice: 0.58, runnerUp: 0.56 }), false);
	assert.equal(acceptMatch({ ...clear, alternativeMatch: 0.7 }), true, "an absolute alternative probability is no longer a veto");
});

test("whole-icon proposals suppress partial masks without dropping slight edge trims or detached marks", () => {
	const candidate = (x: number, y: number, width: number, height: number) => ({ box: { x, y, width, height }, score: 1, rotation: 0 });
	const whole = candidate(20, 20, 60, 60);
	const partial = candidate(25, 40, 25, 20);
	const edgeTrim = candidate(21, 21, 58, 58);
	const detached = candidate(28, 5, 10, 10);
	assert.deepEqual(completeCandidates([whole, partial, edgeTrim, detached]), [whole, edgeTrim, detached]);
});

test("multipart requests use the image opt-in and never retry HTTP failures", async (context) => {
	let calls = 0;
	context.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
		calls++;
		assert.equal(url.href, "https://api.typesafe.ai/v1/systemone");
		assert.equal(options.redirect, "error");
		assert.equal(options.credentials, "omit");
		assert.equal(new Headers(options.headers).get("TypeSafe-Danger-Zone-Images"), "true");
		assert.equal(new Headers(options.headers).get("Authorization"), "Bearer test-secret");
		assert.ok(options.body instanceof FormData);
		const json = options.body.get("request"); assert.ok(json instanceof Blob);
		const body = JSON.parse(await json.text());
		assert.equal(body.model, "jev-latest");
		assert.ok(body.assets[body.state.target]);
		assert.equal(body.assets[body.state.target].part, "target");
		return new Response("do not echo this body", { status: 429 });
	});
	await assert.rejects(askTypesafe({ apiKey: "test-secret", baseUrl: "https://api.typesafe.ai", model: "jev-latest" }, { target: new Blob(["image"]) }, questions, performance.now() + 10_000), /HTTP 429/);
	assert.equal(calls, 1);
});

test("expired and aborted requests stop before network input", async (context) => {
	let calls = 0;
	context.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(response()); });
	const config = { apiKey: "test-secret", baseUrl: "https://api.typesafe.ai", model: "jev-latest" };
	await assert.rejects(askTypesafe(config, {}, questions, performance.now() + 1_000), /deadline/);
	await assert.rejects(askTypesafe(config, {}, questions, performance.now() + 10_000, AbortSignal.abort()));
	await assert.rejects(askTypesafe({ ...config, baseUrl: "http://api.typesafe.ai" }, {}, questions, performance.now() + 10_000), /HTTPS/);
	assert.equal(calls, 0);
});

test("a running API request receives the remaining deadline and stops without a retry", async (context) => {
	let calls = 0;
	context.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
		calls++;
		return new Promise<Response>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("deadline was not propagated")), 500);
			options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
		});
	});
	await assert.rejects(askTypesafe({ apiKey: "test-secret", baseUrl: "https://api.typesafe.ai", model: "jev-latest" }, {}, questions, performance.now() + 1_530), /timeout|aborted/i);
	assert.equal(calls, 1);
});

test("a Jev response slower than 2.5 seconds can use the remaining recognition budget", async (context) => {
	let calls = 0;
	context.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => {
		calls++;
		return new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => resolve(Response.json(response())), 2_700);
			options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
		});
	});
	const result = await askTypesafe({ apiKey: "test-secret", baseUrl: "https://api.typesafe.ai", model: "jev-latest" }, {}, questions, performance.now() + 10_000);
	assert.equal(result.answers.pick.choice, "c0");
	assert.equal(calls, 1);
});

test("successful requests clear their timeout instead of aborting completed signals later", async (context) => {
	let requestSignal: AbortSignal | null | undefined;
	context.mock.method(globalThis, "fetch", async (_url: URL, options: RequestInit) => { requestSignal = options.signal; return Response.json(response()); });
	await askTypesafe({ apiKey: "test-secret", baseUrl: "https://api.typesafe.ai", model: "jev-latest" }, {}, questions, performance.now() + 1_550);
	await new Promise((resolve) => setTimeout(resolve, 90));
	assert.ok(requestSignal);
	assert.equal(requestSignal.aborted, false);
});
