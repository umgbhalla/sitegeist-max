import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { frameRectToViewport, pixelRectToViewportCenter, viewportRectToPixels } from "./geometry.js";
import { executeOrderedClicks, type InteractionResult, selectUnambiguousMatches } from "./interaction.js";
import { type VerificationNextAction, verificationNextAction } from "./next-action.js";
import { rankShapes, thresholdDark } from "./shape.js";
import { TencentVerificationDriver } from "./tencent-driver.js";
import { loadTypesafeConfig } from "./typesafe-client.js";
import {
	ATTEMPT_THRESHOLDS,
	type JevRecognition,
	JevRecognitionError,
	recognizeWithJev,
} from "./typesafe-recognition.js";

const rectSchema = Type.Object({
	x: Type.Number(),
	y: Type.Number(),
	width: Type.Number(),
	height: Type.Number(),
});

const schema = Type.Object({
	method: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("shape"), Type.Literal("jev")], {
			description:
				"auto uses Jev when configured locally; shape uses local math only; jev requires Typesafe configuration",
		}),
	),
	reference: Type.Optional(
		Type.Object(
			{
				...rectSchema.properties,
			},
			{ description: "Bounding box of the reference strip in viewport CSS pixels" },
		),
	),
	scene: Type.Optional(
		Type.Object(rectSchema.properties, {
			description: "Bounding box of the challenge image in viewport CSS pixels",
		}),
	),
	count: Type.Integer({ minimum: 1, maximum: 8, description: "Number of evenly spaced reference symbols" }),
	attempt: Type.Optional(
		Type.Boolean({
			description:
				"Attempt one Tencent challenge when the user has authorized it and matches are sufficiently distinct",
		}),
	),
});

type Params = Static<typeof schema>;

interface Candidate {
	x: number;
	y: number;
	width: number;
	height: number;
	score: number;
}

interface Details {
	tabId: number;
	processingMs: number;
	elapsedMs?: number;
	rankings: Candidate[][];
	method?: "shape" | "jev";
	jev?: Pick<JevRecognition, "stages" | "matches" | "thresholds"> & { reason?: string };
	interaction?: InteractionResult;
	nextAction?: VerificationNextAction;
}

/** Analyze symbols, with an optional single attempt in a discovered Tencent frame. */
export class VerificationShapeTool implements AgentTool<typeof schema, Details> {
	name = "verification_shape_match";
	label = "Compare verification symbols";
	description =
		"Compare an ordered reference strip against symbols in a screenshot. Give the number of reference symbols. With local Typesafe configuration, auto uses a bounded Jev grid, local rotation/contrast matching, candidate selection, crop/distractor checks, and one extra aligned-comparison review per uncertain target when time remains. It uses attempt-oriented gates and returns the active thresholds and review evidence. Only scene/reference crops are sent to Typesafe. Otherwise auto uses local shape matching. Tencent bounds can be discovered; otherwise supply both bounds in viewport CSS pixels. Scores and acceptance gates are provisional. With attempt:true, and only when the user has authorized it, try one challenge when all checks pass within ten seconds. Each click requires a visible marker; no input is retried. A changed, failed or uncertain result is unresolved.";
	parameters = schema;
	windowId?: number;

	async execute(_id: string, args: Params, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		if (signal?.aborted) throw new Error("Verification analysis aborted");
		if (this.windowId === undefined) throw new Error("Browser window is unavailable");
		const [tab] = await chrome.tabs.query({ active: true, windowId: this.windowId });
		if (tab?.id === undefined) throw new Error("No active browser tab");
		const tabId = tab.id;
		const config = args.method === "shape" ? undefined : await loadTypesafeConfig();
		if (args.method === "jev" && !config)
			throw new Error("Typesafe is not configured in this build; add local .env values and rebuild");
		if (Boolean(args.reference) !== Boolean(args.scene))
			throw new Error("Provide both reference and scene bounds, or neither");
		let referenceBounds = args.reference;
		let sceneBounds = args.scene;
		let individualReferences: { x: number; y: number; width: number; height: number }[] | undefined;
		let childFrameId: number | undefined;
		let frameBounds: { x: number; y: number; width: number; height: number } | undefined;
		let frameViewport: { width: number; height: number } | undefined;
		if (args.attempt && args.reference) throw new Error("Automatic interaction requires Tencent frame discovery");
		if (!referenceBounds || !sceneBounds) {
			const frames = await chrome.scripting.executeScript({
				target: { tabId, allFrames: true },
				func: () => {
					const rect = (element: Element | null) => {
						if (!element) return null;
						const box = element.getBoundingClientRect();
						return { x: box.x, y: box.y, width: box.width, height: box.height };
					};
					const icons = Array.from(document.querySelectorAll("#instruction .tc-instruction-icon"));
					const referenceElements = icons.length
						? icons
						: Array.from(document.querySelectorAll('#instructionWrap img[src*="getcap"]'));
					return {
						frame: rect(document.querySelector("#tcaptcha_iframe_dy")),
						instruction: document.querySelector("#instructionText")?.textContent || "",
						references: referenceElements
							.map(rect)
							.filter((box): box is NonNullable<typeof box> => box !== null && box.width > 0 && box.height > 0),
						scene: rect(document.querySelector("#slideBg")),
						width: window.innerWidth,
						height: window.innerHeight,
					};
				},
			});
			const parent = frames.find((entry) => entry.frameId === 0)?.result?.frame;
			const children = frames.filter((entry) => entry.result?.references.length && entry.result.scene);
			if (!parent || parent.width <= 0 || parent.height <= 0 || children.length !== 1) {
				throw new Error(
					"Could not uniquely locate the visible Tencent reference and image; provide both bounds explicitly",
				);
			}
			const child = children[0]?.result;
			if (!child || !child.references.length || !child.scene || !child.width || !child.height)
				throw new Error("Challenge frame has no layout");
			if (args.attempt && !/select in order|按顺序|依次/.test(child.instruction.toLowerCase())) {
				throw new Error("The frame does not show a supported ordered-selection instruction");
			}
			const map = (box: { x: number; y: number; width: number; height: number }) =>
				frameRectToViewport(box, parent, { width: child.width, height: child.height });
			if (child.references.length === args.count) individualReferences = child.references.map(map);
			else if (child.references.length === 1) referenceBounds = map(child.references[0]);
			else throw new Error("Reference icon count does not match the requested count");
			sceneBounds = map(child.scene);
			childFrameId = children[0].frameId;
			frameBounds = parent;
			frameViewport = { width: child.width, height: child.height };
		}
		const dimensions = await chrome.scripting.executeScript({
			target: { tabId },
			func: () => ({ width: window.innerWidth, height: window.innerHeight }),
		});
		const viewport = dimensions[0]?.result;
		if (!viewport?.width || !viewport.height) throw new Error("Cannot measure the viewport");
		const started = performance.now();
		const deadline = started + 10_000;
		const dataUrl = await chrome.tabs.captureVisibleTab(this.windowId, { format: "png" });
		const [current] = await chrome.tabs.query({ active: true, windowId: this.windowId });
		if (current?.id !== tabId) throw new Error("Active tab changed during screenshot capture");
		const afterCapture = await chrome.scripting.executeScript({
			target: { tabId },
			func: () => ({ width: window.innerWidth, height: window.innerHeight }),
		});
		const currentViewport = afterCapture[0]?.result;
		if (currentViewport?.width !== viewport.width || currentViewport.height !== viewport.height) {
			throw new Error("Viewport changed during screenshot capture");
		}
		if (signal?.aborted) throw new Error("Verification analysis aborted");
		let driver: TencentVerificationDriver | undefined;
		let initialIdentity: string | undefined;
		if (args.attempt && childFrameId !== undefined && frameBounds && frameViewport) {
			driver = new TencentVerificationDriver(
				tabId,
				this.windowId,
				childFrameId,
				frameBounds,
				frameViewport,
				signal,
				deadline,
			);
			const state = await driver.inspect();
			if (state.status !== "open" || !state.identity || state.markers !== 0) {
				throw new Error("Verification challenge is not open with zero selections");
			}
			initialIdentity = state.identity;
		}
		const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
		try {
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Image processing is unavailable");
			context.drawImage(bitmap, 0, 0);
			const scaleX = bitmap.width / viewport.width;
			const scaleY = bitmap.height / viewport.height;
			const scale = { x: scaleX, y: scaleY };
			const scene = viewportRectToPixels(sceneBounds, scale);
			const strip = referenceBounds ? viewportRectToPixels(referenceBounds, scale) : undefined;
			const start = performance.now();
			const references = Array.from({ length: args.count }, (_, index) => {
				const individual = individualReferences?.[index];
				if (!individual && !strip) throw new Error("Reference bounds are missing");
				const left = strip ? Math.round((strip.width * index) / args.count) : 0;
				const right = strip ? Math.round((strip.width * (index + 1)) / args.count) : 0;
				return individual
					? viewportRectToPixels(individual, scale)
					: { x: strip!.x + left, y: strip!.y, width: right - left, height: strip!.height };
			});
			const mapCandidate = ({
				box,
				score,
			}: {
				box: { x: number; y: number; width: number; height: number };
				score: number;
			}) => ({
				...pixelRectToViewportCenter(box, scale),
				width: box.width / scaleX,
				height: box.height / scaleY,
				score: Math.round(score * 1000) / 1000,
			});
			let rankings: Candidate[][];
			let chosen: { x: number; y: number }[] | undefined;
			let jev: Details["jev"];
			if (config) {
				try {
					const result = await recognizeWithJev(canvas, references, scene, config, deadline, signal);
					rankings = result.rankings.map((candidates) => candidates.map(mapCandidate));
					chosen = result.chosen?.map(({ box }) => pixelRectToViewportCenter(box, scale));
					jev = { stages: result.stages, matches: result.matches, thresholds: result.thresholds };
				} catch (error) {
					if (signal?.aborted) throw error;
					rankings = [];
					jev = {
						thresholds: ATTEMPT_THRESHOLDS,
						stages: error instanceof JevRecognitionError ? error.stages : [],
						matches: [],
						reason: error instanceof Error ? error.message : "Typesafe recognition failed",
					};
				}
			} else {
				const mask = thresholdDark(context.getImageData(0, 0, bitmap.width, bitmap.height), 60);
				rankings = references.map((reference) => rankShapes(mask, reference, scene).slice(0, 5).map(mapCandidate));
				chosen = selectUnambiguousMatches(rankings) ?? undefined;
			}
			const details: Details = {
				tabId,
				processingMs: Math.round(performance.now() - start),
				rankings,
				method: config ? "jev" : "shape",
				jev,
			};
			if (args.attempt) {
				if (!chosen || !driver || !initialIdentity || childFrameId === undefined) {
					details.interaction = {
						status: "uncertain",
						acknowledged: 0,
						submissionAttempted: false,
						reason: jev?.reason ?? "Matches did not clear all recognition and separation checks",
					};
				} else {
					const latestUrl = await chrome.tabs.captureVisibleTab(this.windowId, { format: "png" });
					const latest = await createImageBitmap(await (await fetch(latestUrl)).blob());
					try {
						const latestCanvas = new OffscreenCanvas(latest.width, latest.height);
						const latestContext = latestCanvas.getContext("2d");
						if (!latestContext || latest.width !== bitmap.width || latest.height !== bitmap.height)
							throw new Error(
								`Screenshot dimensions changed from ${bitmap.width}x${bitmap.height} to ${latest.width}x${latest.height}`,
							);
						latestContext.drawImage(latest, 0, 0);
						const references =
							individualReferences?.map((rect) => viewportRectToPixels(rect, scale)) ?? (strip ? [strip] : []);
						const unchanged = [scene, ...references].every((rect) => {
							const oldData = context.getImageData(rect.x, rect.y, rect.width, rect.height).data;
							const newData = latestContext.getImageData(rect.x, rect.y, rect.width, rect.height).data;
							return oldData.every((value, index) => value === newData[index]);
						});
						if (!unchanged) {
							details.interaction = {
								status: "changed",
								acknowledged: 0,
								submissionAttempted: false,
								reason: "Challenge image changed before input",
							};
						} else if ((await chrome.tabs.query({ active: true, windowId: this.windowId }))[0]?.id !== tabId) {
							details.interaction = {
								status: "changed",
								acknowledged: 0,
								submissionAttempted: false,
								reason: "Active tab changed before input",
							};
						} else {
							try {
								await chrome.debugger.attach({ tabId }, "1.3");
							} catch (error) {
								if (!(error instanceof Error) || !error.message.includes("already attached")) throw error;
							}
							details.interaction = await executeOrderedClicks(
								driver,
								initialIdentity,
								chosen,
								signal,
								deadline,
							);
						}
					} finally {
						latest.close();
					}
				}
			}
			details.elapsedMs = Math.round(performance.now() - started);
			details.nextAction = verificationNextAction(chosen, details.interaction);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							...details,
							warning:
								"Scores are uncalibrated. Treat an uncertain or changed result as unresolved and do not repeat input automatically.",
						}),
					},
				],
				details,
			};
		} finally {
			bitmap.close();
		}
	}
}
