import assert from "node:assert/strict";
import { test } from "node:test";
import { frameRectToViewport, pixelRectToViewportCenter, viewportRectToPixels } from "../src/verification-sdk/geometry.js";
import { alignShapes, components, cropBinary, rankShapes, rotatedShapeSimilarity, thresholdDark, type BinaryImage } from "../src/verification-sdk/shape.js";

function image(rows: string[]): BinaryImage {
	return { width: rows[0].length, height: rows.length, pixels: Uint8Array.from(rows.join(""), (c) => Number(c === "#")) };
}

test("threshold uses luminance and handles transparent dark pixels", () => {
	const data = { width: 3, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 200, 200, 200, 255]) } as ImageData;
	assert.deepEqual([...thresholdDark(data, 60).pixels], [1, 0, 0]);
});

test("neutral segmentation removes colored shadows while retaining the black overlay", () => {
	const data = { width: 3, height: 1, data: new Uint8ClampedArray([15, 15, 15, 255, 10, 30, 55, 255, 0, 0, 0, 0]) } as ImageData;
	assert.deepEqual([...thresholdDark(data, 60).pixels], [1, 1, 0]);
	assert.deepEqual([...thresholdDark(data, 60, 15).pixels], [1, 0, 0]);
});

test("internal chart bars are not proposed as complete symbols", () => {
	const mask: BinaryImage = { width: 240, height: 100, pixels: new Uint8Array(240 * 100) };
	const fill = (x: number, y: number, width: number, height: number) => {
		for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) mask.pixels[row * mask.width + column] = 1;
	};
	// Reference and a complete standalone 1.
	fill(9, 5, 4, 24); fill(5, 25, 12, 4);
	fill(64, 20, 4, 24); fill(60, 40, 12, 4);
	// Disconnected bars inside one enclosing chart component.
	fill(130, 20, 30, 2); fill(130, 48, 30, 2);
	fill(130, 20, 2, 30); fill(158, 20, 2, 30);
	fill(140, 26, 6, 16);
	const ranks = rankShapes(mask, { x: 5, y: 5, width: 12, height: 24 }, { x: 40, y: 0, width: 200, height: 100 });
	assert.deepEqual(ranks[0].box, { x: 60, y: 20, width: 12, height: 24 });
	assert.ok(ranks.some(({ box }) => box.x === 130 && box.width === 30));
	assert.ok(ranks.every(({ box }) => box.x !== 140 || box.y !== 26));
});

test("components join diagonal pixels and reject small noise", () => {
	const found = components(image(["#.....", ".#..##", "....##"]), 2);
	assert.deepEqual(found, [{ x: 0, y: 0, width: 2, height: 2 }, { x: 4, y: 1, width: 2, height: 2 }]);
});

test("shape comparison recognizes a rotated asymmetric shape", () => {
	const a = image(["#...", "#...", "###.", "...."]);
	const rotated = image(["###.", "#...", "#...", "...."]);
	const different = image(["####", "####", "####", "####"]);
	assert.ok(rotatedShapeSimilarity(a, rotated) > rotatedShapeSimilarity(a, different));
});

test("local alignment stops when its CPU budget has expired", () => {
	const symbol = image(["#..", "#..", "###"]);
	assert.throws(() => alignShapes(symbol, symbol, 18, 24, performance.now() - 1), /recognition budget/);
});

test("shape comparison ignores padding and does not match empty crops", () => {
	const a = image(["#.", "##"]);
	const padded = image(["....", ".#..", ".##.", "...."]);
	const empty = image(["..", ".."]);
	assert.ok(rotatedShapeSimilarity(a, padded) > 0.95);
	assert.equal(rotatedShapeSimilarity(a, empty), 0);
});

test("crop uses exclusive bounds and rejects out-of-range rectangles", () => {
	const source = image(["#...", ".##.", "...."]);
	assert.deepEqual([...cropBinary(source, { x: 1, y: 1, width: 2, height: 1 }).pixels], [1, 1]);
	assert.throws(() => cropBinary(source, { x: 3, y: 1, width: 2, height: 1 }), /outside/);
});

test("ranking returns coordinates in the source image", () => {
	const source = image([
		".........................",
		".##.........##...........",
		".#..........#............",
		".#..........#............",
		".#..........#............",
		".#..........#............",
		".#..........#............",
		".#..........#............",
		".#..........#............",
		".######.....######.......",
		".######.....######.......",
		".........................",
	].map((row) => row.padEnd(110, ".")));
	const results = rankShapes(source, { x: 0, y: 0, width: 9, height: 12 }, { x: 10, y: 0, width: 100, height: 12 });
	assert.deepEqual(results[0]?.box, { x: 12, y: 1, width: 6, height: 10 });
	assert.ok(results[0]?.score > 0.95);
});

test("coordinates map between CSS viewport and screenshot pixels", () => {
	const scale = { x: 1.6, y: 2 };
	const pixels = viewportRectToPixels({ x: 20, y: 10, width: 40, height: 30 }, scale);
	assert.deepEqual(pixels, { x: 32, y: 20, width: 64, height: 60 });
	assert.deepEqual(pixelRectToViewportCenter(pixels, scale), { x: 40, y: 25 });
});

test("frame geometry maps scaled inner coordinates into the top viewport", () => {
	assert.deepEqual(
		frameRectToViewport(
			{ x: 10, y: 20, width: 30, height: 40 },
			{ x: 100, y: 200, width: 180, height: 270 },
			{ width: 360, height: 360 },
		),
		{ x: 105, y: 215, width: 15, height: 30 },
	);
});
