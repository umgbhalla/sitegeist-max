import { frameRectToViewport } from "./geometry.js";
import type { ChallengeState, InteractionDriver, Point } from "./interaction.js";
import type { Rect } from "./shape.js";

interface FrameSnapshot {
	identity: string;
	markers: number;
	status: ChallengeState["status"];
	button: { x: number; y: number; width: number; height: number } | null;
	width: number;
	height: number;
}

export class TencentVerificationDriver implements InteractionDriver {
	constructor(
		private readonly tabId: number,
		private readonly windowId: number,
		private readonly frameId: number,
		private readonly expectedFrame: Rect,
		private readonly expectedViewport: { width: number; height: number },
		private readonly signal?: AbortSignal,
		private readonly deadline?: number,
		private readonly expectedSelections?: number,
	) {}

	private async frame(): Promise<FrameSnapshot> {
		const [active] = await chrome.tabs.query({ active: true, windowId: this.windowId });
		if (active?.id !== this.tabId) throw new Error("Active tab changed");
		const [outer] = await chrome.scripting.executeScript({
			target: { tabId: this.tabId },
			func: () => {
				const frame = document.querySelector("#tcaptcha_iframe_dy");
				if (!frame) return null;
				const r = frame.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			},
		});
		const actual = outer?.result;
		if (
			!actual ||
			(["x", "y", "width", "height"] as const).some((key) => Math.abs(actual[key] - this.expectedFrame[key]) > 0.5)
		) {
			throw new Error("Verification frame moved or resized");
		}
		const [entry] = await chrome.scripting.executeScript({
			target: { tabId: this.tabId, frameIds: [this.frameId] },
			func: () => {
				const visible = (element: Element | null) => {
					if (!element) return false;
					const rect = element.getBoundingClientRect();
					if (rect.width <= 0 || rect.height <= 0) return false;
					for (let node: Element | null = element; node; node = node.parentElement) {
						const style = getComputedStyle(node);
						if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
							return false;
					}
					return true;
				};
				const scene = document.querySelector("#slideBg");
				const refs = Array.from(
					document.querySelectorAll("#instruction .tc-instruction-icon, #instructionWrap img[src*='getcap']"),
				);
				const background = scene ? getComputedStyle(scene).backgroundImage : "";
				const images = scene
					? Array.from(scene.querySelectorAll("img")).map((image) => image.currentSrc || image.src)
					: [];
				const identity =
					scene && refs.length && (background.startsWith("url(") || images.some(Boolean))
						? JSON.stringify([
								background,
								getComputedStyle(scene).backgroundPosition,
								getComputedStyle(scene).backgroundSize,
								getComputedStyle(scene).filter,
								getComputedStyle(scene).transform,
								images,
								refs.map((node) => [
									getComputedStyle(node).backgroundImage,
									getComputedStyle(node).backgroundPosition,
									node instanceof HTMLImageElement ? node.currentSrc : "",
								]),
							])
						: "";
				const success = document.querySelector(".tc-success");
				const failure = document.querySelector("#coverFail");
				const successText = document.querySelector("#statusSuccess")?.textContent || "";
				const status =
					visible(success) && /success|passed|成功|通过/i.test(successText)
						? "success"
						: visible(failure)
							? "failure"
							: scene && refs.length
								? "open"
								: "missing";
				const button = Array.from(document.querySelectorAll(".verify-btn")).find(visible);
				const r = button?.getBoundingClientRect();
				return {
					identity,
					markers: Array.from(document.querySelectorAll(".tc-click-mark")).filter(visible).length,
					status,
					button: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
					width: window.innerWidth,
					height: window.innerHeight,
				} as const;
			},
		});
		if (!entry?.result) throw new Error("Cannot read the verification frame");
		if (entry.result.width !== this.expectedViewport.width || entry.result.height !== this.expectedViewport.height) {
			throw new Error("Verification frame viewport changed");
		}
		return entry.result;
	}

	async inspect(): Promise<ChallengeState> {
		const state = await this.frame();
		return { identity: state.identity, markers: state.markers, status: state.status };
	}

	async click(point: Point): Promise<void> {
		if (this.signal?.aborted) throw new Error("Verification input aborted");
		if (this.deadline !== undefined && performance.now() >= this.deadline)
			throw new Error("Verification time limit reached");
		try {
			await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: point.x,
				y: point.y,
				button: "left",
				clickCount: 1,
			});
		} finally {
			await chrome.debugger.sendCommand({ tabId: this.tabId }, "Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: point.x,
				y: point.y,
				button: "left",
				clickCount: 1,
			});
		}
	}

	async submit(): Promise<void> {
		const child = await this.frame();
		if (!child.button || child.status !== "open") throw new Error("Verification submit button is unavailable");
		if (this.expectedSelections !== undefined && child.markers !== this.expectedSelections)
			throw new Error(
				`Expected ${this.expectedSelections} selection markers before submission; found ${child.markers}`,
			);
		const [parent] = await chrome.scripting.executeScript({
			target: { tabId: this.tabId },
			func: () => {
				const frame = document.querySelector("#tcaptcha_iframe_dy");
				if (!frame) return null;
				const r = frame.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			},
		});
		if (!parent?.result) throw new Error("Verification frame is unavailable");
		const frame = parent.result;
		if (
			(["x", "y", "width", "height"] as const).some((key) => Math.abs(frame[key] - this.expectedFrame[key]) > 0.5)
		) {
			throw new Error("Verification frame moved before submission");
		}
		const box = frameRectToViewport(child.button, frame, child);
		await this.click({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
	}

	async wait(): Promise<void> {
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
}
