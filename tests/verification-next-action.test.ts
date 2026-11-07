import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionResult } from "../src/tools/verification/interaction.js";
import { verificationNextAction } from "../src/tools/verification/next-action.js";

const targets = [{ x: 12, y: 34 }, { x: 56, y: 78 }];
const uncertain: InteractionResult = { status: "uncertain", acknowledged: 0, submissionAttempted: false, reason: "Unclear" };

test("accepted analysis supplies an ordered click-and-verify instruction", () => {
	const result = verificationNextAction(targets);
	assert.equal(result.action, "click_and_verify");
	assert.deepEqual(result.targets, targets);
	assert.match(result.instruction, /click OK once/);
	assert.match(result.instruction, /numbered marker/);
});

test("a pre-input abstention asks for visual resolution without claiming input occurred", () => {
	const result = verificationNextAction(undefined, uncertain);
	assert.equal(result.action, "inspect_matches");
	assert.equal(result.targets, undefined);
	assert.match(result.instruction, /Try to resolve the matches visually/);
	assert.match(result.instruction, /specific symbol or position/);
});

test("zero acknowledged clicks still require marker inspection after input dispatch", () => {
	for (const event of ["input_started", "input_dispatched", "input_uncertain"] as const) {
		const result = verificationNextAction(targets, { ...uncertain, events: [{ event, atMs: 1, point: targets[0] }] });
		assert.equal(result.action, "inspect_markers");
		assert.equal(result.targets, undefined);
	}
	assert.equal(verificationNextAction(targets, { ...uncertain, acknowledged: 1 }).action, "inspect_markers");
});

test("submission uncertainty requests outcome verification rather than another click", () => {
	const result = verificationNextAction(targets, { ...uncertain, submissionAttempted: true });
	assert.equal(result.action, "verify_submission");
	assert.equal(result.targets, undefined);
	assert.match(result.instruction, /Do not click it again/);
});

test("completed and changed attempts never return stale click targets", () => {
	for (const [status, action] of [["success", "continue_task"], ["failure", "report_failure"], ["changed", "inspect_changed_challenge"]] as const) {
		const result = verificationNextAction(targets, { ...uncertain, status, submissionAttempted: true });
		assert.equal(result.action, action);
		assert.equal(result.targets, undefined);
	}
});
