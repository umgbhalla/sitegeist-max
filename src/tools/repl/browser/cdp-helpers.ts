/**
 * The first shared CDP abstraction for sitegeist (no prior one exists).
 *
 * Wraps chrome.debugger with:
 *  - attachActiveTab(): resolve {tabId} from chrome.tabs.query active+currentWindow,
 *    attach protocol '1.3', swallow 'already attached'
 *  - cdp(domain, method, params): typed call
 *  - keepalive ping (<20s) to survive service-worker teardown
 *  - lazy re-attach on 'Detached' / 'not attached'
 *  - typed CdpError {code, hint}
 */

export class CdpError extends Error {
	code: string;
	hint: string;
	constructor(code: string, message: string, hint: string) {
		super(message);
		this.name = "CdpError";
		this.code = code;
		this.hint = hint;
	}
}

let attachedTabId: number | undefined;
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

async function resolveActiveTabId(): Promise<number> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		throw new CdpError("NO_ACTIVE_TAB", "No active tab found", "Focus a normal web page tab and try again.");
	}
	if (
		tab.url?.startsWith("chrome://") ||
		tab.url?.startsWith("chrome-extension://") ||
		tab.url?.startsWith("moz-extension://") ||
		tab.url?.startsWith("about:")
	) {
		throw new CdpError(
			"PROTECTED_PAGE",
			`Cannot attach to ${tab.url}`,
			"Switch to a normal http/https page; extension and internal pages are protected.",
		);
	}
	return tab.id;
}

function attachRaw(tabId: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		chrome.debugger.attach({ tabId }, "1.3", () => {
			const err = chrome.runtime.lastError;
			if (err) {
				const msg = err.message || "";
				if (msg.includes("already attached")) {
					// Already attached by us — fine. Attached by DevTools — surfaced on first command.
					resolve();
					return;
				}
				if (msg.includes("Another debugger") || msg.includes("Cannot access")) {
					reject(
						new CdpError(
							"CDP_BUSY",
							msg,
							"Close DevTools on this tab; only one debugger client per target is allowed.",
						),
					);
					return;
				}
				reject(new CdpError("CDP_ATTACH_FAILED", msg, "Could not attach the debugger to the active tab."));
				return;
			}
			resolve();
		});
	});
}

/**
 * Attach the debugger to the current active tab (idempotent), starting the
 * keepalive ping so the session survives service-worker teardown.
 */
export async function attachActiveTab(): Promise<number> {
	const tabId = await resolveActiveTabId();
	await attachRaw(tabId);
	attachedTabId = tabId;
	startKeepalive();
	return tabId;
}

function startKeepalive(): void {
	if (keepaliveTimer) return;
	// Ping well under the ~30s SW idle teardown so the session stays alive.
	keepaliveTimer = setInterval(() => {
		if (attachedTabId == null) return;
		chrome.debugger
			.sendCommand({ tabId: attachedTabId }, "Runtime.evaluate", { expression: "0", returnByValue: true })
			.catch(() => {
				// Session gone — drop it; next cdp() call lazily re-attaches.
				attachedTabId = undefined;
			});
	}, 15000);
}

function sendRaw(tabId: number, method: string, params?: object): Promise<unknown> {
	return chrome.debugger.sendCommand({ tabId }, method, params as { [key: string]: unknown } | undefined);
}

/**
 * Typed CDP call on the active tab. Auto-attaches, lazily re-attaches after SW
 * teardown, and runs without an extension confirmation dialog.
 */
export async function cdp(domain: string, method: string, params?: object): Promise<unknown> {
	const fq = `${domain}.${method}`;

	// Ensure attached (and that the session still belongs to the active tab).
	const tabId = await attachActiveTab();

	try {
		return await sendRaw(tabId, fq, params);
	} catch (e: any) {
		const msg = String(e?.message || e);
		if (msg.includes("Detached") || msg.includes("not attached")) {
			// Lazy re-attach once, then retry.
			attachedTabId = undefined;
			await attachRaw(tabId);
			attachedTabId = tabId;
			try {
				return await sendRaw(tabId, fq, params);
			} catch (e2: any) {
				throw new CdpError("CDP_CALL_FAILED", String(e2?.message || e2), `CDP ${fq} failed after re-attach.`);
			}
		}
		if (msg.includes("Another debugger") || msg.includes("Cannot access")) {
			throw new CdpError(
				"CDP_BUSY",
				msg,
				"Close DevTools on this tab; only one debugger client per target is allowed.",
			);
		}
		throw new CdpError("CDP_CALL_FAILED", msg, `CDP ${fq} failed.`);
	}
}
