import {
	COMPLETE_MESSAGE,
	EXPORT_MESSAGE,
	isCompletionResponse,
	LABEL_MESSAGE,
	SHOW_RECORDINGS_MESSAGE,
} from "./messages.js";

const replaceEvent = "jev-verification:replace-control";
document.dispatchEvent(new Event(replaceEvent));
const previous = document.getElementById("jev-verification-control");
if (previous) {
	// Keep pre-fix controls connected but inert: their old observers otherwise
	// reinsert the removed node. New versions dispose their own listeners above.
	previous.id = "jev-verification-retired-control";
	const retired = document.createElement("div");
	retired.dataset.jevControlRoot = "retired";
	retired.style.setProperty("display", "none", "important");
	retired.inert = true;
	previous.before(retired);
	retired.append(previous);
}

// This script never receives the API key. The first visible challenge starts one
// automatic attempt; the button starts a manual attempt. Failures never auto-retry.
const host = document.createElement("div");
host.id = "jev-verification-control";
host.dataset.jevControlRoot = "active";
host.style.cssText =
	"all:initial!important;position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important";
const shadow = host.attachShadow({ mode: "open" });
const style = document.createElement("style");
style.textContent = `
:host{color-scheme:light}section{box-sizing:border-box;width:290px;padding:16px;background:#fff;color:#18181b;border:1px solid #d4d4d8;border-radius:12px;box-shadow:0 6px 28px #0003;font:14px/1.45 system-ui,sans-serif}
h2{font-size:15px;margin:0 0 6px}p{margin:0 0 12px}button{font:inherit;border:0;border-radius:7px;background:#18181b;color:white;padding:9px 12px;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #2563eb;outline-offset:3px}button:disabled{opacity:.5;cursor:default}a{display:block;color:#1d4ed8;margin-top:10px}details{margin-top:10px}pre{font:11px/1.4 monospace;white-space:pre-wrap;max-height:200px;overflow:auto}summary{cursor:pointer}`;
const panel = document.createElement("section");
panel.setAttribute("aria-label", "Jev verification");
const title = document.createElement("h2");
title.textContent = "Jev verification";
const status = document.createElement("p");
status.setAttribute("role", "status");
status.textContent = "Verification starts automatically when this challenge appears. Use Complete to try again.";
const button = document.createElement("button");
button.type = "button";
button.textContent = "Complete verification";
const dismiss = document.createElement("button");
dismiss.type = "button";
dismiss.textContent = "Hide";
dismiss.style.cssText = "float:right;padding:2px 5px;background:transparent;color:#52525b;font-size:12px";
dismiss.setAttribute("aria-label", "Hide verification control");
const evidence = document.createElement("details");
evidence.hidden = true;
const summary = document.createElement("summary");
summary.textContent = "Attempt details";
const log = document.createElement("pre");
const download = document.createElement("a");
download.textContent = "Save attempt log";
download.download = "jev-verification-attempt.json";
const exportOne = document.createElement("button");
exportOne.type = "button";
exportOne.textContent = "Export this run with images";
exportOne.hidden = true;
const exportRecent = document.createElement("button");
exportRecent.type = "button";
exportRecent.textContent = "Export latest 20 runs";
exportRecent.style.cssText = "margin-top:10px;background:#3f3f46";
const feedback = document.createElement("div");
feedback.hidden = true;
const observed = document.createElement("select");
observed.setAttribute("aria-label", "Observed verification result");
for (const [value, text] of [
	["success", "It passed"],
	["failure", "It failed"],
	["uncertain", "Result unclear"],
]) {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = text;
	observed.append(option);
}
observed.value = "uncertain";
const note = document.createElement("input");
note.placeholder = "Optional calibration note";
note.setAttribute("aria-label", "Calibration note");
note.maxLength = 2000;
note.style.cssText = "box-sizing:border-box;width:100%;margin:6px 0";
const saveFeedback = document.createElement("button");
saveFeedback.type = "button";
saveFeedback.textContent = "Save observed result";
feedback.append(observed, note, saveFeedback);
evidence.append(summary, log, download, exportOne, feedback);
panel.append(dismiss, title, status, button, exportRecent, evidence);
shadow.append(style, panel);
const AUTO_START_DELAY_MS = 1_200;
let running = false;
let finished = false;
let autoAttempted = false;
let visibleSince = 0;
let visibleElement: Element | undefined;
let reportUrl: string | undefined;
let dismissed = false;
let lastVisible = false;
let disposed = false;
let disconnected = false;
let currentRunId: string | undefined;
let showHistory = false;

function showRecordings(message: unknown, sender: chrome.runtime.MessageSender): void {
	if (
		sender.id !== chrome.runtime.id ||
		typeof message !== "object" ||
		message === null ||
		!("type" in message) ||
		message.type !== SHOW_RECORDINGS_MESSAGE
	)
		return;
	showHistory = true;
	dismissed = false;
	if (!running) status.textContent = "Saved verification recordings are ready to export.";
	render();
}
if (runtimeAvailable()) chrome.runtime.onMessage.addListener(showRecordings);

async function recordingAction(message: Record<string, unknown>): Promise<void> {
	if (!runtimeAvailable()) {
		showDisconnected();
		return;
	}
	status.textContent =
		message.type === LABEL_MESSAGE ? "Saving observed result..." : "Preparing calibration export...";
	try {
		const response: unknown = await chrome.runtime.sendMessage(message);
		if (typeof response !== "object" || response === null || !("ok" in response) || response.ok !== true)
			throw new Error(
				typeof response === "object" && response !== null && "error" in response
					? String(response.error)
					: "Recording operation failed",
			);
		status.textContent =
			message.type === LABEL_MESSAGE
				? "Observed result saved for calibration."
				: "Calibration dataset download started.";
	} catch (error) {
		status.textContent = error instanceof Error ? error.message : "Recording operation failed";
	}
}

exportRecent.addEventListener("click", (event) => {
	if (event.isTrusted && !running) void recordingAction({ type: EXPORT_MESSAGE });
});
exportOne.addEventListener("click", (event) => {
	if (event.isTrusted && !running && currentRunId)
		void recordingAction({ type: EXPORT_MESSAGE, runIds: [currentRunId] });
});
saveFeedback.addEventListener("click", (event) => {
	if (event.isTrusted && !running && currentRunId)
		void recordingAction({ type: LABEL_MESSAGE, runId: currentRunId, outcome: observed.value, notes: note.value });
});

function runtimeAvailable(): boolean {
	try {
		return (
			typeof chrome !== "undefined" &&
			Boolean(chrome.runtime?.id) &&
			typeof chrome.runtime?.sendMessage === "function"
		);
	} catch {
		return false;
	}
}

function showReport(value: unknown): void {
	const json = JSON.stringify(value, null, 2);
	log.textContent = json;
	if (reportUrl) URL.revokeObjectURL(reportUrl);
	reportUrl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
	download.href = reportUrl;
	evidence.hidden = false;
}

function visibleFrame(): Element | undefined {
	return Array.from(document.querySelectorAll("#tcaptcha_iframe_dy")).find((frame) => {
		const rect = frame.getBoundingClientRect();
		if (
			rect.width <= 0 ||
			rect.height <= 0 ||
			rect.bottom <= 0 ||
			rect.right <= 0 ||
			rect.top >= innerHeight ||
			rect.left >= innerWidth
		)
			return false;
		for (let node: Element | null = frame; node; node = node.parentElement) {
			const css = getComputedStyle(node);
			if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0) return false;
		}
		return true;
	});
}

function render(): void {
	if (disposed) return;
	if (!host.isConnected && document.documentElement) document.documentElement.append(host);
	// Hide the component while measuring and clicking so it cannot cover targets.
	const frame = visibleFrame();
	const visible = Boolean(frame);
	if (visible && !lastVisible) dismissed = false;
	lastVisible = visible;
	button.hidden = !visible;
	const display = dismissed || running || (!finished && !visible && !showHistory) ? "none" : "block";
	if (host.style.getPropertyValue("display") !== display) host.style.setProperty("display", display, "important");
	maybeAutoStart(frame);
}

/** One automatic attempt per page: any started attempt consumes it, and failure never retries. */
function maybeAutoStart(frame: Element | undefined): void {
	if (!frame) {
		visibleElement = undefined;
		visibleSince = 0;
		return;
	}
	if (visibleElement !== frame) {
		visibleElement = frame;
		visibleSince = performance.now();
		return;
	}
	if (autoAttempted || running) return;
	// Background tabs and unfocused windows keep the timer fresh instead of starting work.
	if (document.visibilityState !== "visible" || !document.hasFocus()) {
		visibleSince = performance.now();
		return;
	}
	if (performance.now() - visibleSince < AUTO_START_DELAY_MS) return;
	void attempt(true);
}

function showDisconnected(): void {
	disconnected = true;
	status.textContent = "Extension connection lost. Reload this page once to reconnect.";
	button.disabled = true;
	button.textContent = "Reload page to reconnect";
	showReport({ ok: false, phase: "connection", error: "Extension context is unavailable" });
}

dismiss.addEventListener("click", () => {
	dismissed = true;
	render();
});

async function attempt(automatic: boolean): Promise<void> {
	if (running || (automatic && autoAttempted)) return;
	if (!runtimeAvailable()) {
		if (automatic) return;
		showDisconnected();
		return;
	}
	autoAttempted = true;
	running = true;
	currentRunId = undefined;
	exportOne.hidden = true;
	feedback.hidden = true;
	observed.value = "uncertain";
	note.value = "";
	button.disabled = true;
	button.textContent = "Working...";
	status.textContent = automatic
		? "Verification started automatically. One attempt is running (up to five minutes). Keep this tab active."
		: "One attempt is running (up to five minutes). Keep this tab active.";
	evidence.hidden = true;
	render();
	try {
		const response: unknown = await chrome.runtime.sendMessage({ type: COMPLETE_MESSAGE, automatic });
		if (!isCompletionResponse(response)) throw new Error("The extension returned no attempt result");
		showReport(response.ok ? response.details : response);
		const recording = response.ok ? response.details.telemetry : response.telemetry;
		currentRunId = recording?.stored ? recording.runId : undefined;
		exportOne.hidden = !currentRunId;
		feedback.hidden = !currentRunId;
		if (!response.ok) {
			status.textContent = automatic
				? `Automatic attempt failed: ${response.error}. Use the button to try this challenge once.`
				: `${response.error}. No automatic retry.`;
			return;
		}
		const details = response.details;
		const interaction = details.interaction;
		status.textContent =
			interaction?.status === "success"
				? `Verification passed. ${interaction.acknowledged} selections confirmed.`
				: `${interaction?.reason ?? "Outcome unconfirmed"}. ${interaction?.acknowledged ?? 0} selections confirmed. ${
						automatic ? "Use the button to try this challenge once." : "No automatic retry."
					}`;
	} catch (error) {
		if (!runtimeAvailable()) showDisconnected();
		else {
			const message = error instanceof Error ? error.message : "Attempt failed";
			status.textContent = automatic
				? `Automatic attempt failed: ${message}. Use the button to try this challenge once.`
				: `${message}. No automatic retry.`;
			showReport({ ok: false, phase: "connection", error: message });
		}
	} finally {
		running = false;
		finished = true;
		if (!disconnected) {
			button.disabled = false;
			button.textContent = "Try current challenge once";
		}
		render();
	}
}

button.addEventListener("click", (event) => {
	if (!event.isTrusted || running) return;
	void attempt(false);
});

// Observe page changes only; the shadow UI's updates do not schedule themselves.
let scheduled = false;
function schedule(): void {
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		render();
	});
}
const observer = new MutationObserver((records) => {
	if (
		records.some((record) => !(record.target instanceof Element && record.target.closest("[data-jev-control-root]")))
	)
		schedule();
});
observer.observe(document, { childList: true, attributes: true, subtree: true });
// CSS transitions and stylesheet changes can expose an iframe without a DOM
// mutation. This cheap visibility check only contacts the extension and Jev after
// a visible challenge has stayed stable long enough to auto-start one attempt.
const visibilityTimer = setInterval(() => {
	if (document.querySelector("#tcaptcha_iframe_dy")) render();
}, 100);
addEventListener("resize", schedule);
addEventListener("scroll", schedule, true);
document.addEventListener("load", schedule, true);
document.addEventListener("visibilitychange", schedule);
document.addEventListener("transitionend", schedule, true);
document.addEventListener("animationend", schedule, true);

function dispose(): void {
	if (disposed) return;
	disposed = true;
	if (runtimeAvailable()) chrome.runtime.onMessage.removeListener(showRecordings);
	observer.disconnect();
	clearInterval(visibilityTimer);
	removeEventListener("resize", schedule);
	removeEventListener("scroll", schedule, true);
	document.removeEventListener("load", schedule, true);
	document.removeEventListener("visibilitychange", schedule);
	document.removeEventListener("transitionend", schedule, true);
	document.removeEventListener("animationend", schedule, true);
	document.removeEventListener(replaceEvent, dispose);
	if (reportUrl) URL.revokeObjectURL(reportUrl);
	host.remove();
}
document.addEventListener(replaceEvent, dispose);
(
	globalThis as typeof globalThis & { __jevVerificationControl?: { isConnected: () => boolean } }
).__jevVerificationControl = {
	isConnected: () => !disposed && host.isConnected && runtimeAvailable(),
};
render();
