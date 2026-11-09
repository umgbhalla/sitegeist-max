import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShapeCandidate } from "../src/verification-sdk/shape.js";
import {
	duplicatesSelection,
	type MatchEvidence,
	replacementIndex,
	resolveDuplicateSelections,
} from "../src/verification-sdk/typesafe-recognition.js";

// Recorded target-1 candidates for the failing run 5b31c4be, in viewport pixels.
const targetOne: ShapeCandidate[] = [
	{ box: { x: 754.850495049505, y: 721.5237623762376, width: 36.65940594059406, height: 36.103960396039604 }, score: 0.826, rotation: 0 },
	{ box: { x: 915.3742574257426, y: 642.0950495049506, width: 36.103960396039604, height: 36.65940594059406 }, score: 0.818, rotation: 0 },
	{ box: { x: 875.3821782178218, y: 685.9752475247525, width: 33.88217821782178, height: 32.21584158415842 }, score: 0.815, rotation: 0 },
	{ box: { x: 803.1742574257426, y: 518.7861386138613, width: 7.220792079207921, height: 6.665346534653466 }, score: 0.765, rotation: 0 },
	{ box: { x: 882.6029702970297, y: 565.4435643564357, width: 19.996039603960398, height: 27.772277227722775 }, score: 0.755, rotation: 0 },
];

// Target 0 already selected the temple at the same location target 1 selected.
const temple: ShapeCandidate = {
	box: { x: 875.3821782178218, y: 684.3089108910891, width: 34.43762376237624, height: 34.43762376237624 },
	score: 0.997,
	rotation: 0,
};

// Target 1's confident grid region (r0, probability 0.89) in viewport pixels.
const region = { x: 670.43, y: 518.79, width: 197.17, height: 141.07 };

function evidence(overrides: Partial<MatchEvidence> = {}): MatchEvidence {
	return {
		selected: 2,
		alternative: 1,
		accepted: true,
		choice: 0.5,
		runnerUp: 0.28,
		match: 0.07,
		alternativeMatch: 0.07,
		shapeScore: 0.815,
		shapeMargin: -0.011,
		decision: {
			strategy: "aligned-comparison",
			initial: 2,
			outline: 1,
			noulWinner: 3,
			probabilities: { c2: 0.5, c1: 0.28, c3: 0.22 },
		},
		...overrides,
	};
}

test("two selections on one symbol are duplicates, distinct symbols are not", () => {
	assert.equal(duplicatesSelection(temple.box, targetOne[2].box), true);
	assert.equal(duplicatesSelection(temple.box, targetOne[1].box), false);
	assert.equal(duplicatesSelection(targetOne[3].box, targetOne[4].box), false);
});

test("a duplicate yields to the candidate inside the target's confident grid region", () => {
	// Without the region prior, probability ranks the smiley (c1) above the cat fragment (c3).
	assert.equal(replacementIndex(targetOne, evidence(), [temple.box]), 1);
	// The region prior rejects the smiley and keeps the only candidate in the target's region.
	assert.equal(replacementIndex(targetOne, evidence(), [temple.box], region), 3);
});

test("a weak region candidate does not override a stronger shape match outside it", () => {
	const weak = targetOne.map((candidate, index) => (index === 3 ? { ...candidate, score: 0.5 } : candidate));
	assert.equal(replacementIndex(weak, evidence(), [temple.box], region), 1);
});

test("an unresolved duplicate is reported instead of clicking one point twice", () => {
	const results = [
		{ chosen: temple, evidence: evidence({ selected: 0, alternative: 1 }) },
		{ chosen: targetOne[2], evidence: evidence() },
	];
	assert.equal(resolveDuplicateSelections(results, [targetOne, targetOne], [undefined, region]), false);
	assert.equal(results[0].chosen, temple);
	assert.equal(results[1].chosen, targetOne[3]);
	assert.equal(results[1].evidence.selected, 3);
	assert.deepEqual(results[1].evidence.deduplication, {
		status: "reassigned",
		duplicateOf: 0,
		from: 2,
		to: 3,
		fromBox: targetOne[2].box,
		toBox: targetOne[3].box,
		reason: "Duplicate selection reassigned within reference order",
	});

	const blocked = [
		{ chosen: temple, evidence: evidence({ selected: 0, alternative: 1 }) },
		{ chosen: targetOne[2], evidence: evidence() },
	];
	const onlyDuplicates = [temple, targetOne[2]];
	assert.equal(resolveDuplicateSelections(blocked, [onlyDuplicates, onlyDuplicates], [undefined, undefined]), true);
	assert.equal(blocked[1].chosen, targetOne[2]);
	assert.equal(blocked[1].evidence.deduplication?.status, "unresolved");
});
