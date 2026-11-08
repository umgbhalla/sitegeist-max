import { VERIFICATION_BUDGET, verificationBudget } from "./budget.js";
import { deadlineSignal } from "./deadline.js";
import { VisionResponseCache } from "./response-cache.js";
import type { VerificationTelemetryRecorder } from "./telemetry.js";
import type { TypesafeConfig } from "./typesafe-client.js";
import { runVerification, type VerificationDetails, type VerificationParams } from "./workflow.js";

const activeWindows = new Set<number>();

export class VerificationCompletionError extends Error {
	readonly budget;

	constructor(
		message: string,
		readonly elapsedMs: number,
		readonly phase: "setup" | "verification",
	) {
		super(message);
		this.name = "VerificationCompletionError";
		this.budget = verificationBudget(elapsedMs);
	}
}

/** One completion policy and browser driver for both extension entry points. */
export async function completeVerification(
	windowId: number,
	args: VerificationParams = {},
	signal?: AbortSignal,
	expectedTabId?: number,
	options: {
		cache?: VisionResponseCache;
		loadConfig?: () => Promise<TypesafeConfig | undefined>;
		telemetry?: VerificationTelemetryRecorder;
	} = {},
): Promise<VerificationDetails> {
	if (activeWindows.has(windowId)) throw new Error("A verification attempt is already running in this window");
	activeWindows.add(windowId);
	const started = performance.now();
	const cache = options.cache ?? new VisionResponseCache();
	const deadline = started + VERIFICATION_BUDGET.limitMs;
	const timeout = deadlineSignal(deadline, "Verification reached its five-minute limit", signal);
	let attachedTab: number | undefined;
	let phase: "setup" | "verification" = "setup";
	try {
		timeout.signal.throwIfAborted();
		const [active] = await chrome.tabs.query({ active: true, windowId });
		if (active?.id === undefined) throw new Error("No active browser tab");
		const tabId = active.id;
		options.telemetry?.event("active_tab", { tabId, url: active.url });
		if (expectedTabId !== undefined && expectedTabId !== tabId) throw new Error("Keep the verification tab active");
		const config = await options.loadConfig?.();
		if (!config) throw new Error("Typesafe is not configured; supply a configuration loader");
		timeout.signal.throwIfAborted();
		// Attach before measuring: Chrome's debugger banner can resize the viewport.
		try {
			await chrome.debugger.attach({ tabId }, "1.3");
			attachedTab = tabId;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("already attached")) throw error;
		}
		await chrome.scripting.executeScript({
			target: { tabId: tabId },
			func: async () => {
				let previous = "";
				let stable = 0;
				for (let poll = 0; poll < 10; poll++) {
					await new Promise<void>((resolve) => setTimeout(resolve, 50));
					const rect = document.querySelector("#tcaptcha_iframe_dy")?.getBoundingClientRect();
					const current = JSON.stringify([innerWidth, innerHeight, rect?.x, rect?.y, rect?.width, rect?.height]);
					stable = current === previous ? stable + 1 : 0;
					if (stable >= 2) return;
					previous = current;
				}
				throw new Error("Wait for the verification layout to stop moving");
			},
		});
		phase = "verification";
		timeout.signal.throwIfAborted();
		const details = await runVerification(windowId, args, timeout.signal, {
			tabId: tabId,
			deadline,
			policy: "best-effort",
			cache,
			loadConfig: async () => config,
			telemetry: options.telemetry,
			capture: async () => {
				const result: unknown = await chrome.debugger.sendCommand({ tabId: tabId }, "Page.captureScreenshot", {
					format: "png",
					fromSurface: true,
					captureBeyondViewport: false,
				});
				if (typeof result !== "object" || result === null || !("data" in result) || typeof result.data !== "string")
					throw new Error("Chrome returned no viewport screenshot");
				return `data:image/png;base64,${result.data}`;
			},
		});
		details.elapsedMs = Math.round(performance.now() - started);
		details.budget = verificationBudget(details.elapsedMs);
		if (details.interaction?.status !== "success") cache.clear();
		return details;
	} catch (error) {
		cache.clear();
		throw new VerificationCompletionError(
			error instanceof Error ? error.message : "Verification attempt failed",
			Math.round(performance.now() - started),
			phase,
		);
	} finally {
		timeout.dispose();
		if (attachedTab !== undefined) await chrome.debugger.detach({ tabId: attachedTab }).catch(() => undefined);
		activeWindows.delete(windowId);
	}
}
