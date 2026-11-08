import { loadTypesafeConfig } from "../verification-config.js";
import { downloadVerificationTelemetry } from "../verification-export.js";
import {
	VerificationClient,
	VerificationCompletionError,
	verificationTelemetryReference,
} from "../verification-sdk/index.js";
import {
	COMPLETE_MESSAGE,
	type CompletionResponse,
	EXPORT_MESSAGE,
	LABEL_MESSAGE,
	SHOW_RECORDINGS_MESSAGE,
} from "./messages.js";

// One manual attempt at a time also avoids Chrome's global screenshot quota.
let running = false;
const verification = new VerificationClient({ loadConfig: loadTypesafeConfig });

async function complete(sender: chrome.runtime.MessageSender): Promise<CompletionResponse> {
	const tab = sender.tab;
	if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tab?.id === undefined || tab.windowId === undefined)
		return { ok: false, error: "Start from the verification button on the page" };
	if (running) return { ok: false, error: "An attempt is already running" };
	running = true;
	try {
		return { ok: true, details: await verification.verify({ windowId: tab.windowId, tabId: tab.id }) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Verification attempt failed",
			telemetry: verificationTelemetryReference(error),
			...(error instanceof VerificationCompletionError
				? { elapsedMs: error.elapsedMs, phase: error.phase, budget: error.budget }
				: {}),
		};
	} finally {
		running = false;
	}
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
	if (typeof message !== "object" || message === null || !("type" in message)) return false;
	if (message.type === COMPLETE_MESSAGE) {
		void complete(sender).then(sendResponse);
		return true;
	}
	if (message.type !== EXPORT_MESSAGE && message.type !== LABEL_MESSAGE) return false;
	if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined) {
		sendResponse({ ok: false, error: "Use the verification controls on the page" });
		return false;
	}
	const operation = async () => {
		if (running) throw new Error("Wait for the current attempt to finish");
		if (message.type === EXPORT_MESSAGE) {
			const runIds =
				"runIds" in message && Array.isArray(message.runIds) && message.runIds.every((id) => typeof id === "string")
					? (message.runIds as string[])
					: undefined;
			return downloadVerificationTelemetry({ runIds, limit: 20 });
		}
		if (
			!("runId" in message) ||
			typeof message.runId !== "string" ||
			!("outcome" in message) ||
			(message.outcome !== "success" && message.outcome !== "failure" && message.outcome !== "uncertain")
		)
			throw new Error("Provide a run and observed outcome");
		await verification.telemetry.labelRun(message.runId, {
			outcome: message.outcome,
			notes: "notes" in message && typeof message.notes === "string" ? message.notes : undefined,
		});
		return { labelled: true };
	};
	void operation().then(
		(details) => sendResponse({ ok: true, ...details }),
		(error: unknown) =>
			sendResponse({ ok: false, error: error instanceof Error ? error.message : "Recording operation failed" }),
	);
	return true;
});

async function injectControl(tab: chrome.tabs.Tab, force = false): Promise<void> {
	if (tab.id === undefined || !/^https?:/.test(tab.url ?? "")) return;
	if (!force) {
		const health = await chrome.scripting
			.executeScript({
				target: { tabId: tab.id },
				injectImmediately: true,
				func: () =>
					(
						globalThis as typeof globalThis & { __jevVerificationControl?: { isConnected: () => boolean } }
					).__jevVerificationControl?.isConnected() ?? false,
			})
			.catch(() => []);
		if (health[0]?.result) return;
	}
	await chrome.scripting
		.executeScript({ target: { tabId: tab.id }, files: ["content.js"], injectImmediately: true })
		.catch(() => undefined);
}

async function reconnectOpenTabs(): Promise<void> {
	const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
	tabs.sort((a, b) => Number(b.active) - Number(a.active));
	await Promise.allSettled(tabs.map((tab) => injectControl(tab)));
}

// Existing documents keep old content-script contexts after extension reload.
// Replace only the control; never reload the challenge or start an attempt.
chrome.runtime.onInstalled.addListener(() => {
	void reconnectOpenTabs();
});
chrome.runtime.onStartup.addListener(() => {
	void reconnectOpenTabs();
});
chrome.action.onClicked.addListener((tab) => {
	void injectControl(tab, true).then(async () => {
		if (tab.id !== undefined)
			await chrome.tabs.sendMessage(tab.id, { type: SHOW_RECORDINGS_MESSAGE }).catch(() => undefined);
	});
});
void reconnectOpenTabs();
