import { type BinaryImage, type Rect, rankShapes, type ShapeCandidate, thresholdDark } from "./shape.js";
import {
	askTypesafe,
	type TypesafeConfig,
	type VisionAnswer,
	type VisionQuestion,
	type VisionResponse,
} from "./typesafe-client.js";

export interface RecognitionStage {
	stage: string;
	ms: number;
	model: string;
	usage: VisionResponse["usage"];
	error?: string;
}

interface MatchSignals {
	choice: number;
	runnerUp: number;
	match: number;
	alternativeMatch: number;
	shapeScore: number;
	shapeMargin: number;
}

export interface MatchEvidence extends MatchSignals {
	selected: number;
	alternative: number;
	accepted: boolean;
	refinement?: {
		status: "accepted" | "unresolved" | "skipped_deadline" | "failed";
		before: MatchSignals & { selected: number; alternative: number };
		reason?: string;
	};
}

export class JevRecognitionError extends Error {
	constructor(
		message: string,
		readonly stages: RecognitionStage[],
	) {
		super(message);
		this.name = "JevRecognitionError";
	}
}

export interface JevRecognition {
	rankings: ShapeCandidate[][];
	chosen?: ShapeCandidate[];
	stages: RecognitionStage[];
	matches: MatchEvidence[];
	thresholds: typeof ATTEMPT_THRESHOLDS;
}

export const ATTEMPT_THRESHOLDS = {
	shapeScore: 0.7,
	choice: 0.55,
	choiceLead: 0.05,
	match: 0.4,
	matchLeadOverAlternative: -0.1,
} as const;

/** Keep crop coordinates in the original screenshot; only model images are resized. */
export function gridRegions(scene: Rect): Rect[] {
	const regions: Rect[] = [];
	for (let row = 0; row < 2; row++) {
		for (let column = 0; column < 2; column++) {
			const left = Math.floor(scene.width * Math.max(0, column / 2 - 0.08));
			const top = Math.floor(scene.height * Math.max(0, row / 2 - 0.08));
			const right = Math.ceil(scene.width * Math.min(1, (column + 1) / 2 + 0.08));
			const bottom = Math.ceil(scene.height * Math.min(1, (row + 1) / 2 + 0.08));
			regions.push({ x: scene.x + left, y: scene.y + top, width: right - left, height: bottom - top });
		}
	}
	return regions;
}

export function searchRegion(answer: VisionAnswer, regions: Rect[], scene: Rect): Rect {
	const options = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
	// An unsure region must not exclude a target. Search the full scene instead.
	if (!options[0] || options[0][1] < 0.7) return scene;
	const selected = options.slice(0, options[0][1] >= 0.9 ? 1 : 2).map(([key]) => regions[Number(key.slice(1))]);
	if (selected.some((rect) => !rect)) return scene;
	const x = Math.min(...selected.map((rect) => rect.x));
	const y = Math.min(...selected.map((rect) => rect.y));
	return {
		x,
		y,
		width: Math.max(...selected.map((rect) => rect.x + rect.width)) - x,
		height: Math.max(...selected.map((rect) => rect.y + rect.height)) - y,
	};
}

/** Attempt-oriented gates; these numbers are not calibrated accuracy estimates. */
export function acceptMatch(evidence: MatchSignals): boolean {
	if (
		![
			evidence.shapeScore,
			evidence.shapeMargin,
			evidence.choice,
			evidence.runnerUp,
			evidence.match,
			evidence.alternativeMatch,
		].every(Number.isFinite)
	)
		return false;
	return (
		evidence.shapeScore >= ATTEMPT_THRESHOLDS.shapeScore &&
		evidence.choice >= ATTEMPT_THRESHOLDS.choice &&
		evidence.choice - evidence.runnerUp + 1e-9 >= ATTEMPT_THRESHOLDS.choiceLead &&
		evidence.match >= ATTEMPT_THRESHOLDS.match &&
		evidence.match - evidence.alternativeMatch + 1e-9 >= ATTEMPT_THRESHOLDS.matchLeadOverAlternative
	);
}

/** Square letterboxing preserves aspect ratio and satisfies the 280px minimum. */
export async function visionCrop(source: OffscreenCanvas, rect: Rect, padding = 0): Promise<Blob> {
	const x = Math.max(0, Math.floor(rect.x - padding));
	const y = Math.max(0, Math.floor(rect.y - padding));
	const right = Math.min(source.width, Math.ceil(rect.x + rect.width + padding));
	const bottom = Math.min(source.height, Math.ceil(rect.y + rect.height + padding));
	if (right <= x || bottom <= y) throw new Error("Vision crop is outside the screenshot");
	const width = right - x;
	const height = bottom - y;
	const side = Math.max(280, Math.min(1_568, Math.max(width, height)));
	const canvas = new OffscreenCanvas(side, side);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Image processing is unavailable");
	context.fillStyle = "white";
	context.fillRect(0, 0, side, side);
	const scale = (side - 24) / Math.max(width, height);
	context.drawImage(
		source,
		x,
		y,
		width,
		height,
		(side - width * scale) / 2,
		(side - height * scale) / 2,
		width * scale,
		height * scale,
	);
	return canvas.convertToBlob({ type: "image/png" });
}

/** A new, aligned comparison view reduces field indirection and mental rotation. */
export async function comparisonView(reference: Blob, candidate: Blob, rotation: number): Promise<Blob> {
	const referenceImage = await createImageBitmap(reference);
	let candidateImage: ImageBitmap | undefined;
	try {
		candidateImage = await createImageBitmap(candidate);
		const canvas = new OffscreenCanvas(640, 380);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Image processing is unavailable");
		context.fillStyle = "white";
		context.fillRect(0, 0, 640, 380);
		context.fillStyle = "black";
		context.font = "18px sans-serif";
		context.fillText("Reference", 50, 28);
		context.fillText("Candidate", 370, 28);
		context.drawImage(referenceImage, 50, 100, 220, 220);
		context.translate(480, 210);
		context.rotate(-rotation);
		context.drawImage(candidateImage, -110, -110, 220, 220);
		return await canvas.convertToBlob({ type: "image/png" });
	} finally {
		referenceImage.close();
		candidateImage?.close();
	}
}

export function completeCandidates(candidates: ShapeCandidate[]): ShapeCandidate[] {
	return candidates.filter(
		({ box }) =>
			!candidates.some(
				({ box: outer }) =>
					outer.width * outer.height >= box.width * box.height * 1.5 &&
					outer.x < box.x &&
					outer.y < box.y &&
					outer.x + outer.width > box.x + box.width &&
					outer.y + outer.height > box.y + box.height,
			),
	);
}

function diverseCandidates(masks: BinaryImage[], reference: Rect, scene: Rect, region: Rect): ShapeCandidate[] {
	// A grid answer must not discard a target or clip its component geometry.
	// A partial component in one mask can be enclosed by a whole icon in the other.
	const rankings = completeCandidates(masks.flatMap((mask) => rankShapes(mask, reference, scene, 12))).sort(
		(a, b) => b.score - a.score,
	);
	const result: ShapeCandidate[] = [];
	const add = (candidate: ShapeCandidate) => {
		const center = { x: candidate.box.x + candidate.box.width / 2, y: candidate.box.y + candidate.box.height / 2 };
		if (
			result.every(
				({ box }) =>
					Math.hypot(center.x - box.x - box.width / 2, center.y - box.y - box.height / 2) >
					Math.max(12, Math.min(box.width, box.height) / 2),
			)
		)
			result.push(candidate);
	};
	for (const candidate of rankings) {
		add(candidate);
		if (result.length === 3) break;
	}
	for (const candidate of rankings) {
		const { box } = candidate;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		if (x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height) add(candidate);
		if (result.length === 5) break;
	}
	for (const candidate of rankings) {
		if (result.length >= 5) break;
		add(candidate);
	}
	return result;
}

/** Grid -> local proposals -> closed-set Choice -> crop + distractor checks. */
export async function recognizeWithJev(
	source: OffscreenCanvas,
	references: Rect[],
	scene: Rect,
	config: TypesafeConfig,
	deadline: number,
	signal?: AbortSignal,
): Promise<JevRecognition> {
	const controller = new AbortController();
	const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const stages: RecognitionStage[] = [];
	const ask = async (stage: string, images: Record<string, Blob>, questions: Record<string, VisionQuestion>) => {
		const start = performance.now();
		let response: VisionResponse;
		try {
			response = await askTypesafe(config, images, questions, deadline, workSignal);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Typesafe request failed";
			stages.push({
				stage,
				ms: Math.round(performance.now() - start),
				model: config.model,
				usage: { input_tokens: null, output_tokens: null },
				error: message,
			});
			throw new JevRecognitionError(message, stages);
		}
		stages.push({ stage, ms: Math.round(performance.now() - start), model: response.model, usage: response.usage });
		return response.answers;
	};
	const referenceImages = await Promise.all(references.map((rect) => visionCrop(source, rect)));
	const regions = gridRegions(scene);
	const gridImages: Record<string, Blob> = {};
	for (let index = 0; index < referenceImages.length; index++) gridImages[`target_${index}`] = referenceImages[index];
	for (let index = 0; index < regions.length; index++)
		gridImages[`tile_${index}`] = await visionCrop(source, regions[index]);
	const gridQuestions: Record<string, VisionQuestion> = {};
	for (let index = 0; index < references.length; index++)
		gridQuestions[`region_${index}`] = {
			type: "choice",
			instructions: `Which tile contains the complete black symbol matching \`target_${index}\`, allowing rotation and size changes? Ignore the photograph.`,
			criteria: Object.fromEntries(regions.map((_, tile) => [`r${tile}`, `The image in \`tile_${tile}\``])),
		};
	const grid = await ask("grid", gridImages, gridQuestions);
	workSignal.throwIfAborted();
	const context = source.getContext("2d");
	if (!context) throw new Error("Image processing is unavailable");
	const pixels = context.getImageData(0, 0, source.width, source.height);
	const neutral = thresholdDark(pixels, 60, 15);
	const dark = thresholdDark(pixels, 60);
	const masks = neutral.pixels.every((pixel, index) => pixel === dark.pixels[index]) ? [neutral] : [neutral, dark];
	const rankings = references.map((reference, index) =>
		diverseCandidates(masks, reference, scene, searchRegion(grid[`region_${index}`], regions, scene)),
	);
	if (rankings.some((candidates) => candidates.length < 2))
		return { rankings, stages, matches: [], thresholds: ATTEMPT_THRESHOLDS };

	const results: { chosen: ShapeCandidate; evidence: MatchEvidence }[] = [];
	// At most three concurrent requests, sharing one deadline and cancellation.
	let next = 0;
	const workers = Array.from({ length: Math.min(3, references.length) }, async () => {
		for (;;) {
			const index = next++;
			if (index >= references.length) return;
			workSignal.throwIfAborted();
			const candidates = rankings[index];
			const candidateImages = await Promise.all(candidates.map(({ box }) => visionCrop(source, box, 4)));
			const images: Record<string, Blob> = { target: referenceImages[index] };
			for (let candidate = 0; candidate < candidateImages.length; candidate++)
				images[`candidate_${candidate}`] = candidateImages[candidate];
			const picked = await ask(`choose_${index}`, images, {
				pick: {
					type: "choice",
					instructions:
						"Which candidate black symbol has the same outer outline and internal strokes as `target`, allowing rotation and scale? Similar but different icons do not match.",
					criteria: Object.fromEntries(
						candidates.map((_, candidate) => [`c${candidate}`, `The symbol in \`candidate_${candidate}\``]),
					),
				},
			});
			const choice = picked.pick;
			const selected = Number(choice.choice?.slice(1));
			const probabilities = choice.probabilities ?? {};
			const alternative = candidates
				.map((_, candidate) => candidate)
				.filter((candidate) => candidate !== selected)
				.sort((a, b) => probabilities[`c${b}`] - probabilities[`c${a}`])[0];
			if (!candidates[selected] || alternative === undefined) throw new Error("Typesafe did not select a candidate");
			const checked = await ask(
				`verify_${index}`,
				{
					target: referenceImages[index],
					candidate: candidateImages[selected],
					alternative: candidateImages[alternative],
				},
				{
					match: {
						type: "noul",
						instructions:
							"Does the black symbol in `candidate` match the black symbol in `target`, allowing rotation and scale?",
					},
					alternative: {
						type: "noul",
						instructions:
							"Does the black symbol in `alternative` match the black symbol in `target`, allowing rotation and scale?",
					},
				},
			);
			const shapeScore = candidates[selected].score;
			const shapeMargin =
				shapeScore -
				Math.max(
					...candidates.filter((_, candidate) => candidate !== selected).map((candidate) => candidate.score),
				);
			const evidence = {
				choice: probabilities[`c${selected}`],
				runnerUp: probabilities[`c${alternative}`],
				match: checked.match.noul ?? 0,
				alternativeMatch: checked.alternative.noul ?? 1,
				shapeScore,
				shapeMargin,
			};
			results[index] = {
				chosen: candidates[selected],
				evidence: { ...evidence, selected, alternative, accepted: acceptMatch(evidence) },
			};
			if (!results[index].evidence.accepted) {
				const before = { ...evidence, selected, alternative };
				const current = results[index];
				if (deadline - performance.now() < 3_000) {
					current.evidence.refinement = {
						status: "skipped_deadline",
						before,
						reason: "Time reserved for native input",
					};
					continue;
				}
				try {
					const pair_a = await comparisonView(
						referenceImages[index],
						candidateImages[selected],
						candidates[selected].rotation,
					);
					const pair_b = await comparisonView(
						referenceImages[index],
						candidateImages[alternative],
						candidates[alternative].rotation,
					);
					const reviewed = await ask(
						`refine_${index}`,
						{ pair_a, pair_b },
						{
							pick: {
								type: "choice",
								instructions:
									"Each pair shows a reference on the left and a candidate on the right. Which right-hand candidate is the same black line drawing as its left-hand reference? Compare outer shape and internal strokes; allow small scale and rotation differences.",
								criteria: {
									a: "The candidate in `pair_a`.",
									b: "The candidate in `pair_b`.",
									neither: "Neither candidate matches, or the drawings are unreadable.",
								},
							},
							match_a: {
								type: "noul",
								instructions:
									"In `pair_a`, are the left and right black line drawings the same symbol, allowing small scale and rotation differences?",
							},
							match_b: {
								type: "noul",
								instructions:
									"In `pair_b`, are the left and right black line drawings the same symbol, allowing small scale and rotation differences?",
							},
						},
					);
					if (reviewed.pick.choice === "neither") {
						current.evidence.refinement = {
							status: "unresolved",
							before,
							reason: "Jev selected neither candidate",
						};
						continue;
					}
					const key = reviewed.pick.choice;
					if (key !== "a" && key !== "b") throw new Error("Invalid refinement choice");
					const selectedIndex = key === "a" ? selected : alternative;
					const alternativeIndex = key === "a" ? alternative : selected;
					const probabilities = reviewed.pick.probabilities ?? {};
					const refined = {
						choice: probabilities[key],
						runnerUp: Math.max(
							...Object.entries(probabilities)
								.filter(([option]) => option !== key)
								.map(([, p]) => p),
						),
						match: (key === "a" ? reviewed.match_a.noul : reviewed.match_b.noul) ?? 0,
						alternativeMatch: (key === "a" ? reviewed.match_b.noul : reviewed.match_a.noul) ?? 1,
						shapeScore: candidates[selectedIndex].score,
						shapeMargin:
							candidates[selectedIndex].score -
							Math.max(
								...candidates
									.filter((_, position) => position !== selectedIndex)
									.map((candidate) => candidate.score),
							),
					};
					const accepted = acceptMatch(refined);
					results[index] = {
						chosen: candidates[selectedIndex],
						evidence: {
							...refined,
							selected: selectedIndex,
							alternative: alternativeIndex,
							accepted,
							refinement: { status: accepted ? "accepted" : "unresolved", before },
						},
					};
				} catch (error) {
					if (workSignal.aborted) throw error;
					current.evidence.refinement = {
						status: "failed",
						before,
						reason: error instanceof Error ? error.message : "Refinement failed",
					};
				}
			}
		}
	});
	try {
		await Promise.all(workers);
	} catch (error) {
		controller.abort();
		await Promise.allSettled(workers);
		throw error;
	}
	workSignal.throwIfAborted();
	const chosen = results.map((result) => result.chosen);
	const distinct = chosen.every(({ box }, index) =>
		chosen
			.slice(index + 1)
			.every(
				(other) =>
					Math.hypot(
						box.x + box.width / 2 - other.box.x - other.box.width / 2,
						box.y + box.height / 2 - other.box.y - other.box.height / 2,
					) >
					Math.max(box.width, box.height, other.box.width, other.box.height) / 2,
			),
	);
	return {
		rankings,
		stages,
		matches: results.map((result) => result.evidence),
		chosen: distinct && results.every((result) => result.evidence.accepted) ? chosen : undefined,
		thresholds: ATTEMPT_THRESHOLDS,
	};
}
