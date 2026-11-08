export interface BinaryImage {
	width: number;
	height: number;
	pixels: Uint8Array;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function cropBinary(image: BinaryImage, rect: Rect): BinaryImage {
	if (
		!Number.isInteger(rect.x) ||
		!Number.isInteger(rect.y) ||
		!Number.isInteger(rect.width) ||
		!Number.isInteger(rect.height) ||
		rect.x < 0 ||
		rect.y < 0 ||
		rect.width <= 0 ||
		rect.height <= 0 ||
		rect.x + rect.width > image.width ||
		rect.y + rect.height > image.height
	)
		throw new Error("Crop is outside the image");
	const pixels = new Uint8Array(rect.width * rect.height);
	for (let y = 0; y < rect.height; y++) {
		pixels.set(
			image.pixels.subarray((rect.y + y) * image.width + rect.x, (rect.y + y) * image.width + rect.x + rect.width),
			y * rect.width,
		);
	}
	return { width: rect.width, height: rect.height, pixels };
}

/** Extract dark pixels without assuming an image is opaque. */
export function thresholdDark(
	image: ImageData,
	threshold: number,
	maximumChannelSpread = Number.POSITIVE_INFINITY,
): BinaryImage {
	const pixels = new Uint8Array(image.width * image.height);
	for (let i = 0; i < pixels.length; i++) {
		const j = i * 4;
		const alpha = image.data[j + 3] / 255;
		const luminance =
			(0.2126 * image.data[j] + 0.7152 * image.data[j + 1] + 0.0722 * image.data[j + 2]) * alpha + 255 * (1 - alpha);
		const spread =
			Math.max(image.data[j], image.data[j + 1], image.data[j + 2]) -
			Math.min(image.data[j], image.data[j + 1], image.data[j + 2]);
		pixels[i] = luminance <= threshold && spread <= maximumChannelSpread ? 1 : 0;
	}
	return { width: image.width, height: image.height, pixels };
}

/** Eight-connected components. Rectangles use exclusive right/bottom bounds. */
export function components(image: BinaryImage, minimumPixels = 1): Rect[] {
	const visited = new Uint8Array(image.pixels.length);
	const queue = new Int32Array(image.pixels.length);
	const result: Rect[] = [];
	for (let start = 0; start < image.pixels.length; start++) {
		if (!image.pixels[start] || visited[start]) continue;
		let head = 0;
		let tail = 0;
		queue[tail++] = start;
		visited[start] = 1;
		let minX = image.width;
		let minY = image.height;
		let maxX = 0;
		let maxY = 0;
		while (head < tail) {
			const p = queue[head++];
			const x = p % image.width;
			const y = Math.floor(p / image.width);
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
					const n = ny * image.width + nx;
					if (image.pixels[n] && !visited[n]) {
						visited[n] = 1;
						queue[tail++] = n;
					}
				}
			}
		}
		if (tail >= minimumPixels) result.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
	}
	return result;
}

export interface ShapeCandidate {
	box: Rect;
	score: number;
	rotation: number;
}

export interface ShapeSearchOptions {
	sampleSize?: number;
	coarseAngles?: number;
	refinementAngles?: number;
	deadline?: number;
}

function checkSearchDeadline(deadline?: number): void {
	if (deadline !== undefined && performance.now() >= deadline)
		throw new Error("Local shape search exhausted its recognition budget");
}

/** Rank connected dark shapes. Scores are similarity values, not probabilities. */
export function rankShapes(
	image: BinaryImage,
	reference: Rect,
	scene: Rect,
	refineLimit?: number,
	options: ShapeSearchOptions = {},
): ShapeCandidate[] {
	checkSearchDeadline(options.deadline);
	const template = cropBinary(image, reference);
	const sceneImage = cropBinary(image, scene);
	const maxSize = Math.max(1, Math.round(scene.width * 0.16));
	const connected = components(sceneImage, 12).filter(
		(box) => box.width >= 6 && box.height >= 10 && box.width <= maxSize && box.height <= maxSize,
	);
	// Eyes, chart bars, and building details can be separate components inside
	// one icon. Their enclosing component already crops the complete object.
	// Keep detached marks outside that enclosure for the grouping pass below.
	const boxes = connected.filter(
		(box) =>
			!connected.some(
				(outer) =>
					outer !== box &&
					outer.x < box.x &&
					outer.y < box.y &&
					outer.x + outer.width > box.x + box.width &&
					outer.y + outer.height > box.y + box.height,
			),
	);
	if (boxes.length > 150) throw new Error("Too many dark shapes to rank reliably; narrow the scene bounds");
	// A symbol can consist of disconnected marks, such as a map pin above a frame.
	// Keep the individual components too, because nearby marks may be distractors.
	const grouped: Rect[] = [];
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
			const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
			if (gapX > 3 || gapY > 3) continue;
			const x = Math.min(a.x, b.x);
			const y = Math.min(a.y, b.y);
			const width = Math.max(a.x + a.width, b.x + b.width) - x;
			const height = Math.max(a.y + a.height, b.y + b.height) - y;
			if (width <= maxSize && height <= maxSize) grouped.push({ x, y, width, height });
		}
	}
	const unique = new Map<string, Rect>();
	for (const box of [...boxes, ...grouped]) unique.set(`${box.x},${box.y},${box.width},${box.height}`, box);
	let candidates = [...unique.values()];
	if (refineLimit !== undefined && candidates.length > refineLimit) {
		candidates = candidates
			.map((box) => {
				checkSearchDeadline(options.deadline);
				return {
					box,
					score: alignShapes(
						template,
						cropBinary(sceneImage, box),
						options.coarseAngles ?? 18,
						options.sampleSize ?? 48,
						options.deadline,
					).score,
				};
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, refineLimit)
			.map(({ box }) => box);
	}
	return candidates
		.map((box) => ({
			box: { ...box, x: box.x + scene.x, y: box.y + scene.y },
			...alignShapes(
				template,
				cropBinary(sceneImage, box),
				options.refinementAngles ?? 72,
				options.sampleSize ?? 48,
				options.deadline,
			),
		}))
		.sort((a, b) => b.score - a.score);
}

/** Compare shape occupancy while preserving aspect ratio and testing rotation. */
export function rotatedShapeSimilarity(a: BinaryImage, b: BinaryImage, angleSteps = 72): number {
	return alignShapes(a, b, angleSteps).score;
}

/** Rotation is the angle sampled in b to align it with a, in radians. */
export function alignShapes(
	a: BinaryImage,
	b: BinaryImage,
	angleSteps = 72,
	size = 48,
	deadline?: number,
): { score: number; rotation: number } {
	checkSearchDeadline(deadline);
	const padding = Math.max(2, Math.round(size / 6));
	const tolerance = Math.max(1, Math.round(size / 24));
	const normalize = (image: BinaryImage): Uint8Array => {
		const out = new Uint8Array(size * size);
		let minX = image.width;
		let minY = image.height;
		let maxX = -1;
		let maxY = -1;
		for (let y = 0; y < image.height; y++) {
			for (let x = 0; x < image.width; x++) {
				if (!image.pixels[y * image.width + x]) continue;
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
		if (maxX < minX || maxY < minY) return out;
		const width = maxX - minX + 1;
		const height = maxY - minY + 1;
		const scale = Math.min((size - padding) / width, (size - padding) / height);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const sx = Math.floor((x - size / 2) / scale + minX + width / 2);
				const sy = Math.floor((y - size / 2) / scale + minY + height / 2);
				if (sx >= 0 && sy >= 0 && sx < image.width && sy < image.height)
					out[y * size + x] = image.pixels[sy * image.width + sx];
			}
		}
		return out;
	};
	const left = normalize(a);
	const right = normalize(b);
	const dilate = (pixels: Uint8Array): Uint8Array => {
		const result = new Uint8Array(pixels.length);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (!pixels[y * size + x]) continue;
				for (let dy = -tolerance; dy <= tolerance; dy++) {
					for (let dx = -tolerance; dx <= tolerance; dx++) {
						const nx = x + dx;
						const ny = y + dy;
						if (nx >= 0 && ny >= 0 && nx < size && ny < size) result[ny * size + nx] = 1;
					}
				}
			}
		}
		return result;
	};
	const leftNearby = dilate(left);
	const rightNearby = dilate(right);
	let best = 0;
	let rotation = 0;
	const translation = Math.max(1, Math.round(size / 16));
	const offsets = [-translation, 0, translation];
	for (let step = 0; step < angleSteps; step++) {
		checkSearchDeadline(deadline);
		const angle = (step * Math.PI * 2) / angleSteps;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		for (const scale of [0.8, 0.9, 1, 1.1, 1.2]) {
			// Reuse the affine mapping while preserving rounding after each offset.
			const rotatedX = new Int16Array(offsets.length * size * size);
			const rotatedY = new Int16Array(offsets.length * size * size);
			for (let y = 0; y < size; y++) {
				for (let x = 0; x < size; x++) {
					const index = y * size + x;
					const rx = ((x - size / 2) * cos - (y - size / 2) * sin) * scale + size / 2;
					const ry = ((x - size / 2) * sin + (y - size / 2) * cos) * scale + size / 2;
					for (let offset = 0; offset < offsets.length; offset++) {
						rotatedX[offset * size * size + index] = Math.round(rx + offsets[offset]);
						rotatedY[offset * size * size + index] = Math.round(ry + offsets[offset]);
					}
				}
			}
			for (let offsetX = 0; offsetX < offsets.length; offsetX++) {
				for (let offsetY = 0; offsetY < offsets.length; offsetY++) {
					let matches = 0;
					let total = 0;
					for (let index = 0; index < left.length; index++) {
						const rx = rotatedX[offsetX * size * size + index];
						const ry = rotatedY[offsetY * size * size + index];
						const inside = rx >= 0 && ry >= 0 && rx < size && ry < size;
						const at = ry * size + rx;
						const p = left[index];
						const q = inside ? right[at] : 0;
						matches += p && inside ? rightNearby[at] : 0;
						matches += q ? leftNearby[index] : 0;
						total += p + q;
					}
					if (total && matches / total > best) {
						best = matches / total;
						rotation = angle;
					}
				}
			}
		}
	}
	return { score: best, rotation };
}
