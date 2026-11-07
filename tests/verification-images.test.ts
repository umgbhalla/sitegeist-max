import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { rankShapes, type Rect } from "../src/tools/verification/shape.js";

interface Fixture {
	id: string;
	width: number;
	height: number;
	pixels: string;
	reference: [number, number, number, number];
	scene: [number, number, number, number];
	targets: [number, number][];
}

// Binary masks contain only the challenge scene and reference strip from the
// supplied screenshots, so unrelated page contents are not retained.
const fixtures: Fixture[] = JSON.parse(
	await readFile(new URL("./verification-image-fixtures.json", import.meta.url), "utf8"),
);

for (const refineLimit of [undefined, 12]) test(`saved verification examples rank each observed target first (${refineLimit ? "coarse/fine" : "full"})`, () => {
	for (const fixture of fixtures) {
		const image = {
			width: fixture.width,
			height: fixture.height,
			pixels: new Uint8Array(inflateSync(Buffer.from(fixture.pixels, "base64"))),
		};
		const [x, y, width, height] = fixture.reference;
		const [sx, sy, sw, sh] = fixture.scene;
		const scene: Rect = { x: sx, y: sy, width: sw, height: sh };
		for (let index = 0; index < fixture.targets.length; index++) {
			const left = Math.round((width * index) / fixture.targets.length);
			const right = Math.round((width * (index + 1)) / fixture.targets.length);
			const [targetX, targetY] = fixture.targets[index];
			const best = rankShapes(image, { x: x + left, y, width: right - left, height }, scene, refineLimit)[0];
			assert.ok(best, `${fixture.id} target ${index + 1} has no candidates`);
			assert.ok(
				targetX >= best.box.x && targetX < best.box.x + best.box.width && targetY >= best.box.y && targetY < best.box.y + best.box.height,
				`${fixture.id} target ${index + 1}: unexpected best match ${JSON.stringify(best.box)}`,
			);
		}
	}
});
