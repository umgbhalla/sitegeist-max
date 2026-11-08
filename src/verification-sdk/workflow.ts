import { VERIFICATION_BUDGET, verificationBudget } from "./budget.js";
import { frameRectToViewport, pixelRectToViewportCenter, viewportRectToPixels } from "./geometry.js";
import { executeOrderedClicks, type InteractionResult, selectUnambiguousMatches } from "./interaction.js";
import { type VerificationNextAction, verificationNextAction } from "./next-action.js";
import type { VisionResponseCache } from "./response-cache.js";
import { rankShapes, thresholdDark } from "./shape.js";
import type { VerificationTelemetryRecorder } from "./telemetry.js";
import { captureVerificationFrame } from "./telemetry-frame.js";
import type { TelemetryReference } from "./telemetry-store.js";
import { TencentVerificationDriver } from "./tencent-driver.js";
import type { TypesafeConfig } from "./typesafe-client.js";
import {
	ATTEMPT_THRESHOLDS,
	type JevRecognition,
	JevRecognitionError,
	recognizeWithJev,
} from "./typesafe-recognition.js";

export interface VerificationParams {
	method?: "auto" | "shape" | "jev";
	reference?: { x: number; y: number; width: number; height: number };
	scene?: { x: number; y: number; width: number; height: number };
	count?: number;
	attempt?: boolean;
}

export interface VerificationOptions {
	policy?: "gated" | "best-effort";
	tabId?: number;
	deadline?: number;
	cache?: VisionResponseCache;
	loadConfig?: () => Promise<TypesafeConfig | undefined>;
	telemetry?: VerificationTelemetryRecorder;
	capture?: (viewport: { width: number; height: number }) => Promise<string>;
}

interface Candidate {
	x: number;
	y: number;
	width: number;
	height: number;
	score: number;
}

export interface VerificationDetails {
	tabId: number;
	processingMs: number;
	elapsedMs?: number;
	budget?: ReturnType<typeof verificationBudget>;
	telemetry?: TelemetryReference;
	rankings: Candidate[][];
	method?: "shape" | "jev";
	referenceCount?: number;
	referenceLayout?: { source: "individual-elements" | "combined-strip" | "explicit-bounds"; elementCount: number };
	jev?: Pick<JevRecognition, "stages" | "matches" | "thresholds"> & { reason?: string };
	interaction?: InteractionResult;
	nextAction?: VerificationNextAction;
}

/** Shared browser workflow; independent of the agent and its tool schema. */
export async function runVerification(
	windowId: number,
	args: VerificationParams = {},
	signal?: AbortSignal,
	options: VerificationOptions = {},
): Promise<VerificationDetails> {
	if (signal?.aborted) throw new Error("Verification analysis aborted");
	const started = performance.now();
	const deadline = options.deadline ?? started + VERIFICATION_BUDGET.limitMs;
	const [tab] = await chrome.tabs.query({ active: true, windowId: windowId });
	if (tab?.id === undefined) throw new Error("No active browser tab");
	const tabId = tab.id;
	const telemetry = options.telemetry;
	telemetry?.event("discovery_started", { tabId, url: tab.url });
	if (options.tabId !== undefined && options.tabId !== tabId) throw new Error("Active tab changed before starting");
	const method = args.method ?? "jev";
	const attempt = args.attempt ?? true;
	let count = args.count ?? 3;
	const config = method === "shape" ? undefined : await options.loadConfig?.();
	if (method === "jev" && !config) throw new Error("Typesafe is not configured; supply a configuration loader");
	if (Boolean(args.reference) !== Boolean(args.scene))
		throw new Error("Provide both reference and scene bounds, or neither");
	let referenceBounds = args.reference;
	let sceneBounds = args.scene;
	let individualReferences: { x: number; y: number; width: number; height: number }[] | undefined;
	let childFrameId: number | undefined;
	let frameBounds: { x: number; y: number; width: number; height: number } | undefined;
	let frameViewport: { width: number; height: number } | undefined;
	let referenceLayout: VerificationDetails["referenceLayout"] = args.reference
		? { source: "explicit-bounds", elementCount: 1 }
		: undefined;
	if (attempt && args.reference)
		throw new Error(
			"Automatic interaction requires Tencent frame discovery; set attempt:false to analyze explicit bounds",
		);
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
					verificationScripts: Array.from(document.scripts)
						.map((script) => script.src)
						.filter((src) => /TCaptcha\.js|captcha\.(?:gtimg|qcloud)\.com/i.test(src))
						.slice(0, 12),
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
		telemetry?.event("frame_discovery", frames);
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
		if (telemetry) telemetry.job(captureVerificationFrame(tabId, children[0].frameId, "before", telemetry));
		if (attempt && !/select in order|按顺序|依次/.test(child.instruction.toLowerCase())) {
			throw new Error("The frame does not show a supported ordered-selection instruction");
		}
		const map = (box: { x: number; y: number; width: number; height: number }) =>
			frameRectToViewport(box, parent, { width: child.width, height: child.height });
		// One DOM element can contain the entire three-symbol reference strip.
		// Only multiple elements provide a count without an explicit override.
		if (args.count === undefined && child.references.length > 1) count = child.references.length;
		referenceLayout = {
			source: child.references.length === 1 && count > 1 ? "combined-strip" : "individual-elements",
			elementCount: child.references.length,
		};
		if (child.references.length === count) individualReferences = child.references.map(map);
		else if (child.references.length === 1) referenceBounds = map(child.references[0]);
		else throw new Error("Reference icon count does not match the requested count");
		sceneBounds = map(child.scene);
		childFrameId = children[0].frameId;
		frameBounds = parent;
		frameViewport = { width: child.width, height: child.height };
	}
	if (!Number.isInteger(count) || count < 1 || count > 8)
		throw new Error("Reference count must be between one and eight");
	const dimensions = await chrome.scripting.executeScript({
		target: { tabId },
		func: () => ({ width: window.innerWidth, height: window.innerHeight }),
	});
	const viewport = dimensions[0]?.result;
	if (!viewport?.width || !viewport.height) throw new Error("Cannot measure the viewport");
	const capture = () =>
		options.capture ? options.capture(viewport) : chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	const dataUrl = await capture();
	const [current] = await chrome.tabs.query({ active: true, windowId: windowId });
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
	if (attempt && childFrameId !== undefined && frameBounds && frameViewport) {
		driver = new TencentVerificationDriver(
			tabId,
			windowId,
			childFrameId,
			frameBounds,
			frameViewport,
			signal,
			deadline,
			count,
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
		// Browser screenshots have square pixels. A debugger banner can crop the
		// visible height while innerHeight still reports the emulated viewport.
		const scaleY = scaleX;
		const scale = { x: scaleX, y: scaleY };
		const scene = viewportRectToPixels(sceneBounds, scale);
		const strip = referenceBounds ? viewportRectToPixels(referenceBounds, scale) : undefined;
		const start = performance.now();
		const references = Array.from({ length: count }, (_, index) => {
			const individual = individualReferences?.[index];
			if (!individual && !strip) throw new Error("Reference bounds are missing");
			const left = strip ? Math.round((strip.width * index) / count) : 0;
			const right = strip ? Math.round((strip.width * (index + 1)) / count) : 0;
			return individual
				? viewportRectToPixels(individual, scale)
				: { x: strip!.x + left, y: strip!.y, width: right - left, height: strip!.height };
		});
		const fits = (rect: { x: number; y: number; width: number; height: number }, width: number, height: number) =>
			rect.x >= 0 &&
			rect.y >= 0 &&
			rect.width > 0 &&
			rect.height > 0 &&
			rect.x + rect.width <= width &&
			rect.y + rect.height <= height;
		if (![scene, ...references].every((rect) => fits(rect, bitmap.width, bitmap.height)))
			throw new Error("The reference and challenge image must be fully visible");
		telemetry?.event("image_geometry", {
			viewport,
			screenshot: { width: bitmap.width, height: bitmap.height },
			scale,
			scene,
			references,
			frameBounds,
			frameViewport,
			referenceLayout,
		});
		telemetry?.canvas("before/scene.png", canvas, scene);
		if (frameBounds) telemetry?.canvas("before/frame.png", canvas, viewportRectToPixels(frameBounds, scale));
		for (const [index, reference] of references.entries())
			telemetry?.canvas(`before/reference-${index}.png`, canvas, reference);
		telemetry?.checkpoint();
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
		let jev: VerificationDetails["jev"];
		if (config) {
			try {
				const result = await recognizeWithJev(
					canvas,
					references,
					scene,
					config,
					deadline,
					signal,
					options.policy,
					options.cache,
					telemetry,
				);
				rankings = result.rankings.map((candidates) => candidates.map(mapCandidate));
				chosen = result.chosen?.map(({ box }) => pixelRectToViewportCenter(box, scale));
				jev = { stages: result.stages, matches: result.matches, thresholds: result.thresholds };
			} catch (error) {
				if (signal?.aborted && !(error instanceof JevRecognitionError)) throw error;
				rankings = [];
				jev = {
					thresholds: options.policy === "best-effort" ? null : ATTEMPT_THRESHOLDS,
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
		const details: VerificationDetails = {
			tabId,
			processingMs: Math.round(performance.now() - start),
			rankings,
			method: config ? "jev" : "shape",
			referenceCount: count,
			referenceLayout,
			jev,
		};
		telemetry?.event("recognition_result", { rankings, chosen, jev });
		telemetry?.checkpoint();
		if (attempt) {
			if (!chosen || chosen.length !== count || !driver || !initialIdentity || childFrameId === undefined) {
				details.interaction = {
					status: "uncertain",
					acknowledged: 0,
					submissionAttempted: false,
					reason:
						(chosen && chosen.length !== count
							? `Expected ${count} target selections but recognition produced ${chosen.length}`
							: jev?.reason) ??
						(options.policy === "best-effort"
							? "No valid symbol coordinates were produced"
							: "Matches did not clear all recognition and separation checks"),
				};
			} else {
				const latestUrl = await capture();
				const latest = await createImageBitmap(await (await fetch(latestUrl)).blob());
				try {
					const latestCanvas = new OffscreenCanvas(latest.width, latest.height);
					const latestContext = latestCanvas.getContext("2d");
					if (
						!latestContext ||
						latest.width !== bitmap.width ||
						![scene, ...references].every((rect) => fits(rect, latest.width, latest.height))
					)
						throw new Error(
							`Screenshot dimensions changed from ${bitmap.width}x${bitmap.height} to ${latest.width}x${latest.height}`,
						);
					latestContext.drawImage(latest, 0, 0);
					telemetry?.canvas("before-input/scene.png", latestCanvas, scene);
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
					} else if ((await chrome.tabs.query({ active: true, windowId: windowId }))[0]?.id !== tabId) {
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
						details.interaction = await executeOrderedClicks(driver, initialIdentity, chosen, signal, deadline);
					}
				} finally {
					latest.close();
				}
			}
		}
		telemetry?.event("interaction_result", details.interaction);
		if (telemetry && driver && frameBounds) {
			try {
				const before = await driver.inspect();
				if (before.status !== "missing") {
					const url = await capture();
					const after = await driver.inspect();
					if (after.status !== "missing" && after.identity === before.identity) {
						const image = await createImageBitmap(await (await fetch(url)).blob());
						try {
							const output = new OffscreenCanvas(image.width, image.height);
							output.getContext("2d")?.drawImage(image, 0, 0);
							telemetry.canvas("after/frame.png", output, viewportRectToPixels(frameBounds, scale), {
								markers: after.markers,
								status: after.status,
							});
							telemetry.canvas("after/scene.png", output, scene, {
								markers: after.markers,
								status: after.status,
							});
						} finally {
							image.close();
						}
					}
				}
			} catch {
				telemetry.warn("Post-attempt frame image unavailable; tab, layout, or challenge may have changed");
			}
		}
		if (telemetry && childFrameId !== undefined)
			telemetry.job(captureVerificationFrame(tabId, childFrameId, "after", telemetry));
		details.elapsedMs = Math.round(performance.now() - started);
		details.budget = verificationBudget(details.elapsedMs);
		details.nextAction = verificationNextAction(chosen, details.interaction);
		return details;
	} finally {
		bitmap.close();
	}
}
