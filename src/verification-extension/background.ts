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

// One attempt at a time; automatic and manual starts share this guard, which also
// avoids Chrome's global screenshot quota.
let running = false;
let deleting = false;
const verification = new VerificationClient({
	loadConfig: loadTypesafeConfig,
	telemetry: async () => Boolean((await chrome.storage.local.get({ recordingEnabled: true })).recordingEnabled),
});

async function complete(sender: chrome.runtime.MessageSender, automatic: boolean): Promise<CompletionResponse> {
	const tab = sender.tab;
	if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tab?.id === undefined || tab.windowId === undefined)
		return { ok: false, error: "Start from the verification control on the page" };
	if (running || deleting) return { ok: false, error: "An attempt or recording deletion is already running" };
	running = true;
	try {
		const settings = await chrome.storage.local.get({ automaticExport: false });
		const details = await verification.verify({
			windowId: tab.windowId,
			tabId: tab.id,
			trigger: automatic ? "automatic" : "manual",
		});
		if (settings.automaticExport && details.telemetry?.stored) {
			try {
				await downloadVerificationTelemetry({ runIds: [details.telemetry.runId] });
			} catch (error) {
				const warning = `Automatic export failed: ${error instanceof Error ? error.message : String(error)}`;
				details.telemetry.warnings.push(warning);
				await verification.telemetry.addWarning(details.telemetry.runId, warning).catch(() => undefined);
			}
		}
		return { ok: true, details };
	} catch (error) {
		const reference = verificationTelemetryReference(error);
		const settings = await chrome.storage.local.get({ automaticExport: false });
		if (settings.automaticExport && reference?.stored) {
			try {
				await downloadVerificationTelemetry({ runIds: [reference.runId] });
			} catch (exportError) {
				const warning = `Automatic export failed: ${exportError instanceof Error ? exportError.message : String(exportError)}`;
				reference.warnings.push(warning);
				await verification.telemetry.addWarning(reference.runId, warning).catch(() => undefined);
			}
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Verification attempt failed",
			telemetry: reference,
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
	if (message.type === "verification:show-controls") {
		if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("history.html")) return false;
		void chrome.tabs
			.query({ active: true, lastFocusedWindow: true })
			.then(async ([tab]) => {
				if (!tab?.id || !/^https?:/.test(tab.url ?? "")) throw new Error("Open a web page first");
				await injectControl(tab, true);
				await chrome.tabs.sendMessage(tab.id, { type: SHOW_RECORDINGS_MESSAGE });
			})
			.then(
				() => sendResponse({ ok: true }),
				(error: unknown) =>
					sendResponse({ ok: false, error: error instanceof Error ? error.message : "Could not show controls" }),
			);
		return true;
	}
	if (message.type === "verification:clear-history") {
		if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("history.html")) {
			sendResponse({ ok: false, error: "Open the history panel to delete recordings" });
			return false;
		}
		if (running || deleting) {
			sendResponse({ ok: false, error: "Wait for the current attempt or deletion to finish" });
			return false;
		}
		deleting = true;
		void verification.telemetry
			.clearRuns()
			.then(
				() => sendResponse({ ok: true }),
				(error: unknown) =>
					sendResponse({ ok: false, error: error instanceof Error ? error.message : "Deletion failed" }),
			)
			.finally(() => {
				deleting = false;
			});
		return true;
	}
	if (message.type === COMPLETE_MESSAGE) {
		const automatic = "automatic" in message && message.automatic === true;
		void complete(sender, automatic).then(sendResponse);
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
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
void reconnectOpenTabs();
