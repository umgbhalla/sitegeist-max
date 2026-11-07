import assert from "node:assert/strict";
import { test } from "node:test";
import { TencentVerificationDriver } from "../src/tools/verification/tencent-driver.js";
import { executeOrderedClicks, selectUnambiguousMatches, type ChallengeState, type InteractionDriver } from "../src/tools/verification/interaction.js";

test("ambiguous or repeated targets cannot start an automated attempt", () => {
	const target = { x: 10, y: 10, width: 10, height: 10, score: 1 };
	const near = { x: 10, y: 11, width: 10, height: 10, score: 0.99 };
	const competing = { x: 40, y: 40, width: 10, height: 10, score: 0.97 };
	const different = { ...competing, score: 0.5 };
	assert.equal(selectUnambiguousMatches([[target, competing]]), null);
	assert.equal(selectUnambiguousMatches([[target, near, different], [target, different]]), null);
	assert.deepEqual(selectUnambiguousMatches([[target, near, different]]), [{ x: 10, y: 10 }]);
});

test("submits only after each selection is acknowledged", async () => {
	let markers = 0;
	let submitted = false;
	const clicks: number[] = [];
	const driver: InteractionDriver = {
		inspect: async () => ({ identity: "one", markers, status: submitted ? "success" : "open" }),
		click: async (point) => { clicks.push(point.x); markers++; },
		submit: async () => { submitted = true; },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
	assert.deepEqual(clicks, [1, 2]);
	assert.equal(result.status, "success");
	assert.equal(result.acknowledged, 2);
	assert.equal(result.submissionAttempted, true);
	assert.deepEqual(result.events?.map((entry) => entry.event), ["input_started", "input_dispatched", "acknowledged", "input_started", "input_dispatched", "acknowledged", "submission_started", "submission_dispatched"]);
});

test("an unacknowledged click stops without retry or submission", async () => {
	let clicks = 0;
	let submitted = false;
	const driver: InteractionDriver = {
		inspect: async () => ({ identity: "one", markers: 0, status: "open" }),
		click: async () => { clicks++; },
		submit: async () => { submitted = true; },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
	assert.equal(result.status, "uncertain");
	assert.equal(result.acknowledged, 0);
	assert.equal(clicks, 1);
	assert.equal(submitted, false);
	assert.deepEqual(result.events?.map((entry) => entry.event), ["input_started", "input_dispatched"]);
});

test("a delayed marker can acknowledge the original click without repeating input", async () => {
	let clicks = 0;
	let polls = 0;
	let submitted = false;
	const driver: InteractionDriver = {
		inspect: async () => ({ identity: "one", markers: clicks && ++polls >= 6 ? 1 : 0, status: submitted ? "success" : "open" }),
		click: async () => { clicks++; },
		submit: async () => { submitted = true; },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }], undefined, performance.now() + 1_000);
	assert.equal(result.status, "success");
	assert.equal(result.acknowledged, 1);
	assert.equal(clicks, 1);
	assert.equal(submitted, true);
});

test("a new challenge after submission is not reported as success", async () => {
	let state: ChallengeState = { identity: "one", markers: 0, status: "open" };
	const driver: InteractionDriver = {
		inspect: async () => state,
		click: async () => { state = { ...state, markers: 1 }; },
		submit: async () => { state = { identity: "two", markers: 0, status: "open" }; },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }]);
	assert.equal(result.status, "changed");
	assert.equal(result.submissionAttempted, true);
});

test("a changed challenge prevents the next click", async () => {
	let state: ChallengeState = { identity: "one", markers: 0, status: "open" };
	let clicks = 0;
	const driver: InteractionDriver = {
		inspect: async () => state,
		click: async () => { clicks++; state = { identity: "two", markers: 0, status: "open" }; },
		submit: async () => { throw new Error("must not submit"); },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
	assert.equal(result.status, "changed");
	assert.equal(clicks, 1);
	assert.equal(result.submissionAttempted, false);
});

test("an expired deadline prevents input", async () => {
	const driver: InteractionDriver = {
		inspect: async () => { throw new Error("must not inspect"); },
		click: async () => { throw new Error("must not click"); },
		submit: async () => { throw new Error("must not submit"); },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }], undefined, performance.now() - 1);
	assert.equal(result.status, "uncertain");
	assert.equal(result.submissionAttempted, false);
});

test("cancellation during inspection prevents the next input", async () => {
	const controller = new AbortController();
	let clicks = 0;
	const driver: InteractionDriver = {
		inspect: async () => {
			controller.abort();
			return { identity: "one", markers: 0, status: "open" };
		},
		click: async () => { clicks++; },
		submit: async () => { throw new Error("must not submit"); },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }], controller.signal);
	assert.equal(clicks, 0);
	assert.equal(result.submissionAttempted, false);
});

test("cancellation during the final selection check prevents submission", async () => {
	const controller = new AbortController();
	let inspections = 0;
	let markers = 0;
	let submitted = false;
	const driver: InteractionDriver = {
		inspect: async () => {
			if (++inspections === 3) controller.abort();
			return { identity: "one", markers, status: "open" };
		},
		click: async () => { markers++; },
		submit: async () => { submitted = true; },
		wait: async () => {},
	};
	const result = await executeOrderedClicks(driver, "one", [{ x: 1, y: 1 }], controller.signal);
	assert.equal(submitted, false);
	assert.equal(result.acknowledged, 1);
	assert.equal(result.submissionAttempted, false);
});

test("the native driver rejects cancelled input before dispatch", async () => {
	const controller = new AbortController();
	controller.abort();
	const driver = new TencentVerificationDriver(1, 1, 2,
		{ x: 0, y: 0, width: 360, height: 360 }, { width: 360, height: 360 }, controller.signal);
	await assert.rejects(driver.click({ x: 20, y: 20 }), /aborted/);
});
