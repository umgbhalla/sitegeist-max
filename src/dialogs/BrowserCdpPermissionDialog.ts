import { customElement } from "lit/decorators.js";
import { PermissionDialog } from "./PermissionDialog.js";

/**
 * Human-confirm seam for destructive CDP operations (Fetch.fulfillRequest,
 * Storage.clearDataForOrigin, Network.setCookie, Page.navigate, ...).
 *
 * No chrome.permissions request is needed — the `debugger` permission is already
 * declared. The gate is purely the human click. The grant callback resolves
 * {granted:true} immediately when the user confirms.
 */
@customElement("browser-cdp-permission-dialog")
export class BrowserCdpPermissionDialog extends PermissionDialog {
	private method = "";
	private params?: object;
	private targetUrl?: string;

	/**
	 * Open the dialog for a specific CDP method about to fire.
	 * @param targetUrl the URL of the tab the op will run on, pinned before the
	 *   dialog opens so the human approves a concrete origin (not a re-queried one).
	 * Returns true if the user confirms, false otherwise.
	 */
	static async request(method: string, params?: object, targetUrl?: string): Promise<boolean> {
		const dialog = new BrowserCdpPermissionDialog();
		dialog.method = method;
		dialog.params = params;
		dialog.targetUrl = targetUrl;
		return dialog.requestPermission(async () => ({ granted: true }));
	}

	/** Summarize key params for the human instead of dumping raw JSON. */
	private summarizeParams(): string | undefined {
		const p = this.params as any;
		if (!p || typeof p !== "object") return undefined;
		if (typeof p.origin === "string") return `origin: ${p.origin}`;
		if (p.cookie && typeof p.cookie === "object") {
			return `cookie: ${p.cookie.name ?? "?"} @ ${p.cookie.domain ?? p.cookie.url ?? "?"}`;
		}
		if (typeof p.url === "string") return `url: ${p.url}`;
		if (typeof p.expression === "string") {
			const expr = p.expression.length > 120 ? `${p.expression.slice(0, 120)}…` : p.expression;
			return `expression: ${expr}`;
		}
		return undefined;
	}

	protected header() {
		return {
			title: "Confirm Browser Debugger Action",
			description: "The AI wants to run a destructive Chrome DevTools Protocol command on the active tab",
		};
	}

	protected why(): string {
		return `The AI is about to call the CDP method "${this.method}" on the current tab. This can change cookies, storage, navigation, or network responses, so it requires your explicit confirmation.`;
	}

	protected what(): string[] {
		const items = [
			`CDP method: ${this.method}`,
			this.targetUrl
				? `Target tab: ${this.targetUrl} (pinned now; the call aborts if you switch tabs)`
				: "Runs on the currently active tab via the already-granted debugger permission",
			"Chrome shows a 'Sitegeist is debugging this browser' infobar while attached",
		];
		const summary = this.summarizeParams();
		if (summary) items.push(summary);
		if (this.params && Object.keys(this.params).length > 0) {
			let preview: string;
			try {
				preview = JSON.stringify(this.params);
			} catch {
				preview = "[unserializable]";
			}
			if (preview.length > 200) preview = `${preview.slice(0, 200)}…`;
			items.push(`Parameters: ${preview}`);
		}
		return items;
	}
}
