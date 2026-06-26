import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "@earendil-works/pi-ai";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "@earendil-works/pi-web-ui";
import { i18n, icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Loader2 } from "lucide";
import { SkillPill } from "../components/SkillPill.js";
import { TabPill } from "../components/TabPill.js";
import { NAVIGATE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { formatSkills } from "../utils/format-skills.js";
import "../utils/i18n-extension.js";

// Track tool-initiated navigations to filter out duplicate navigation messages
let isNavigating = false;

export function isToolNavigating(): boolean {
	return isNavigating;
}

function markNavigationStart() {
	isNavigating = true;
}

function markNavigationEnd() {
	isNavigating = false;
}

// ============================================================================
// TYPES
// ============================================================================

const navigateSchema = Type.Object({
	newBlankTab: Type.Optional(Type.Boolean({ description: "Set to true to open a new blank tab" })),
	url: Type.Optional(Type.String({ description: "URL to navigate to (in current tab or new tab if newTab is true)" })),
	newTab: Type.Optional(Type.Boolean({ description: "Set to true to open URL in a new tab instead of current tab" })),
	listTabs: Type.Optional(Type.Boolean({ description: "Set to true to list all open tabs" })),
	switchToTab: Type.Optional(Type.Number({ description: "Tab ID to switch to (get IDs from listTabs)" })),
	closeTab: Type.Optional(Type.Number({ description: "Tab ID to close (get IDs from listTabs)" })),
	duplicateTab: Type.Optional(Type.Number({ description: "Tab ID to duplicate (get IDs from listTabs)" })),
	reloadTab: Type.Optional(Type.Number({ description: "Tab ID to reload (get IDs from listTabs)" })),
	pinTab: Type.Optional(Type.Number({ description: "Tab ID to pin (get IDs from listTabs)" })),
	unpinTab: Type.Optional(Type.Number({ description: "Tab ID to unpin (get IDs from listTabs)" })),
	moveTab: Type.Optional(Type.Number({ description: "Tab ID to move (get IDs from listTabs)" })),
	moveToIndex: Type.Optional(
		Type.Number({ description: "Target index for moveTab. Zero-based within the tab's current window." }),
	),
});

export type NavigateParams = Static<typeof navigateSchema>;

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	active: boolean;
	pinned: boolean;
	windowId: number;
	index: number;
	favicon?: string;
}

export interface NavigateResult {
	finalUrl?: string;
	title?: string;
	favicon?: string;
	tabId?: number;
	skills?: Array<{ name: string; shortDescription: string; fullDetails?: Skill }>;
	tabs?: TabInfo[];
	switchedToTab?: number;
	closedTab?: number;
	duplicatedTab?: number;
	reloadedTab?: number;
	pinnedTab?: number;
	unpinnedTab?: number;
	movedTab?: number;
	createdTab?: number;
}

// ============================================================================
// TOOL
// ============================================================================

export class NavigateTool implements AgentTool<typeof navigateSchema, NavigateResult> {
	label = "Navigate";
	name = "navigate";
	description = NAVIGATE_TOOL_DESCRIPTION;
	parameters = navigateSchema;

	async execute(
		_toolCallId: string,
		args: NavigateParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		if (signal?.aborted) {
			throw new Error("Navigation aborted");
		}

		// Handle list tabs action
		if (args.listTabs) {
			return this.listTabs();
		}

		if (args.newBlankTab) {
			markNavigationStart();
			try {
				return await this.newBlankTab();
			} finally {
				markNavigationEnd();
			}
		}

		// Handle switch tab action
		if ("switchToTab" in args && args.switchToTab !== undefined) {
			markNavigationStart();
			try {
				return await this.switchToTab(args.switchToTab);
			} finally {
				markNavigationEnd();
			}
		}

		if ("closeTab" in args && args.closeTab !== undefined) {
			markNavigationStart();
			try {
				return await this.closeTab(args.closeTab);
			} finally {
				markNavigationEnd();
			}
		}

		if ("duplicateTab" in args && args.duplicateTab !== undefined) {
			markNavigationStart();
			try {
				return await this.duplicateTab(args.duplicateTab);
			} finally {
				markNavigationEnd();
			}
		}

		if ("reloadTab" in args && args.reloadTab !== undefined) {
			markNavigationStart();
			try {
				return await this.reloadTab(args.reloadTab);
			} finally {
				markNavigationEnd();
			}
		}

		if ("pinTab" in args && args.pinTab !== undefined) {
			markNavigationStart();
			try {
				return await this.setPinned(args.pinTab, true);
			} finally {
				markNavigationEnd();
			}
		}

		if ("unpinTab" in args && args.unpinTab !== undefined) {
			markNavigationStart();
			try {
				return await this.setPinned(args.unpinTab, false);
			} finally {
				markNavigationEnd();
			}
		}

		if ("moveTab" in args && args.moveTab !== undefined) {
			if (args.moveToIndex === undefined) {
				throw new Error("moveToIndex is required when moveTab is set");
			}
			markNavigationStart();
			try {
				return await this.moveTab(args.moveTab, args.moveToIndex);
			} finally {
				markNavigationEnd();
			}
		}

		// Get active tab for navigation actions
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});

		if (!tab || !tab.id) {
			throw new Error("No active tab found");
		}

		let finalUrl: string;
		let targetTabId = tab.id;

		markNavigationStart();
		try {
			if ("url" in args && args.url !== undefined) {
				// Check if opening in new tab
				if ("newTab" in args && args.newTab) {
					finalUrl = await this.openInNewTab(args.url, signal);
					// Get the newly created tab
					const tabs = await chrome.tabs.query({});
					const newTab = tabs.find((t: chrome.tabs.Tab) => t.url === finalUrl);
					if (newTab?.id) {
						targetTabId = newTab.id;
					}
				} else {
					// Navigate to URL in current tab
					finalUrl = await this.navigateToUrl(tab.id, args.url, signal);
				}
			} else {
				throw new Error("Invalid navigation parameters");
			}
		} finally {
			markNavigationEnd();
		}

		// Get updated tab info using query (better cross-browser support)
		const updatedTabs = await chrome.tabs.query({});
		const updatedTab = updatedTabs.find((t: chrome.tabs.Tab) => t.id === targetTabId);
		const title = updatedTab?.title || "Untitled";
		const favicon = updatedTab?.favIconUrl;

		// Get skills for the final URL
		const skillsRepo = getSitegeistStorage().skills;
		const matchingSkills = await skillsRepo.getSkillsForUrl(finalUrl);
		const { newOrUpdated, unchanged, formattedText: skillsOutput } = formatSkills(matchingSkills);

		// Build skills array with full details for all skills (needed for UI rendering)
		const skills = [
			...newOrUpdated.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
			...unchanged.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
		];

		const details: NavigateResult = {
			finalUrl,
			title,
			favicon,
			tabId: targetTabId,
			skills,
		};

		// Build output message
		let output = "";
		if ("newTab" in args && args.newTab) {
			output = `Opened in new tab: ${finalUrl} (tab ${targetTabId})\n`;
		} else {
			output = `Navigated to: ${finalUrl} (tab ${targetTabId})\n`;
		}

		output += `\n${skillsOutput}`;

		return { content: [{ type: "text", text: output }], details };
	}

	private async navigateToUrl(tabId: number, url: string, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			// Set up DOMContentLoaded listener (fires when DOM is ready, more reliable than onCompleted)
			const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (details.tabId === tabId && details.frameId === 0) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
					if (abortListener) signal?.removeEventListener("abort", abortListener);
					resolve(details.url);
				}
			};

			// Set up abort listener
			const abortListener = () => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
				}
				reject(new Error("Aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", abortListener);
			}

			chrome.webNavigation.onDOMContentLoaded.addListener(listener);

			// Trigger navigation
			chrome.tabs.update(tabId, { url }).catch((err: Error) => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
				}
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				reject(err);
			});
		});
	}

	private async openInNewTab(url: string, signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) {
			throw new Error("Aborted");
		}

		const newTab = await chrome.tabs.create({ url, active: true });

		if (!newTab.id) {
			throw new Error("Failed to create new tab");
		}

		// Wait for the tab to load
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (details.tabId === newTab.id && details.frameId === 0) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
					if (abortListener) signal?.removeEventListener("abort", abortListener);
					resolve(details.url);
				}
			};

			const abortListener = () => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
				}
				reject(new Error("Aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", abortListener);
			}

			chrome.webNavigation.onDOMContentLoaded.addListener(listener);
		});
	}

	private async listTabs(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tabs = await chrome.tabs.query({});

		const tabInfos: TabInfo[] = tabs
			.filter(
				(t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number; url: string } =>
					t.id !== undefined && t.url !== undefined,
			)
			.map((t: chrome.tabs.Tab & { id: number; url: string }) => ({
				id: t.id,
				url: t.url,
				title: t.title || "Untitled",
				active: t.active || false,
				pinned: t.pinned || false,
				windowId: t.windowId,
				index: t.index,
				favicon: t.favIconUrl,
			}));

		const details: NavigateResult = {
			tabs: tabInfos,
		};

		let output = `Found ${tabInfos.length} open tabs:\n`;
		for (const tab of tabInfos) {
			const activeMarker = tab.active ? " [ACTIVE]" : "";
			const pinnedMarker = tab.pinned ? " [PINNED]" : "";
			output += `  - Tab ${tab.id}: ${tab.title}${activeMarker}${pinnedMarker} (window ${tab.windowId}, index ${tab.index})\n`;
			output += `    URL: ${tab.url}\n`;
		}

		return { content: [{ type: "text", text: output }], details };
	}

	private getNumericTabId(tabId: number | string): number {
		return typeof tabId === "string" ? parseInt(tabId, 10) : tabId;
	}

	private async getTab(tabId: number): Promise<chrome.tabs.Tab & { id: number }> {
		const numericTabId = this.getNumericTabId(tabId);
		const tab = await chrome.tabs.get(numericTabId);
		if (!tab?.id) {
			throw new Error(`Tab ${numericTabId} not found`);
		}
		return tab as chrome.tabs.Tab & { id: number };
	}

	private tabSummary(tab: chrome.tabs.Tab): string {
		const title = tab.title || "Untitled";
		const url = tab.url || "";
		return url ? `${title}\nURL: ${url}` : title;
	}

	private async switchToTab(
		tabId: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		// Ensure tabId is a number (in case it comes through as string)
		const numericTabId = this.getNumericTabId(tabId);

		// Query for the tab to get its details
		const tabs = await chrome.tabs.query({});
		const tab = tabs.find((t: chrome.tabs.Tab) => t.id === numericTabId);

		if (!tab) {
			throw new Error(`Tab ${numericTabId} not found`);
		}

		// Activate the tab
		await chrome.tabs.update(numericTabId, { active: true });

		// Focus the window containing the tab
		if (tab.windowId) {
			await chrome.windows.update(tab.windowId, { focused: true });
		}

		const finalUrl = tab.url || "";
		const title = tab.title || "Untitled";
		const favicon = tab.favIconUrl;

		// Get skills for the tab's URL
		const skillsRepo = getSitegeistStorage().skills;
		const matchingSkills = finalUrl ? await skillsRepo.getSkillsForUrl(finalUrl) : [];
		const { newOrUpdated, unchanged, formattedText: skillsOutput } = formatSkills(matchingSkills);

		// Build skills array with full details for all skills (needed for UI rendering)
		const skills = [
			...newOrUpdated.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
			...unchanged.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
		];

		const details: NavigateResult = {
			finalUrl,
			title,
			favicon,
			tabId: numericTabId,
			skills,
			switchedToTab: numericTabId,
		};

		let output = `Switched to tab ${numericTabId}: ${title}\n`;
		output += `URL: ${finalUrl}\n`;
		output += `\n${skillsOutput}`;

		return { content: [{ type: "text", text: output }], details };
	}

	private async newBlankTab(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tab = await chrome.tabs.create({ active: true });
		if (!tab.id) {
			throw new Error("Failed to create new tab");
		}
		return {
			content: [{ type: "text", text: `Opened new blank tab ${tab.id}` }],
			details: {
				tabId: tab.id,
				createdTab: tab.id,
				finalUrl: tab.url || "",
				title: tab.title || "New Tab",
				favicon: tab.favIconUrl,
			},
		};
	}

	private async closeTab(
		tabId: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tab = await this.getTab(tabId);
		await chrome.tabs.remove(tab.id);
		return {
			content: [{ type: "text", text: `Closed tab ${tab.id}: ${this.tabSummary(tab)}` }],
			details: { closedTab: tab.id },
		};
	}

	private async duplicateTab(
		tabId: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tab = await this.getTab(tabId);
		const duplicated = await chrome.tabs.duplicate(tab.id);
		if (!duplicated?.id) {
			throw new Error(`Failed to duplicate tab ${tab.id}`);
		}
		return {
			content: [
				{ type: "text", text: `Duplicated tab ${tab.id} to tab ${duplicated.id}: ${this.tabSummary(duplicated)}` },
			],
			details: {
				duplicatedTab: duplicated.id,
				tabId: duplicated.id,
				finalUrl: duplicated.url || "",
				title: duplicated.title || "Untitled",
				favicon: duplicated.favIconUrl,
			},
		};
	}

	private async reloadTab(
		tabId: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tab = await this.getTab(tabId);
		await chrome.tabs.reload(tab.id);
		return {
			content: [{ type: "text", text: `Reloaded tab ${tab.id}: ${this.tabSummary(tab)}` }],
			details: {
				reloadedTab: tab.id,
				tabId: tab.id,
				finalUrl: tab.url || "",
				title: tab.title || "Untitled",
				favicon: tab.favIconUrl,
			},
		};
	}

	private async setPinned(
		tabId: number,
		pinned: boolean,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tab = await this.getTab(tabId);
		const updated = await chrome.tabs.update(tab.id, { pinned });
		if (!updated?.id) {
			throw new Error(`Failed to ${pinned ? "pin" : "unpin"} tab ${tab.id}`);
		}
		const details: NavigateResult = {
			tabId: updated.id,
			finalUrl: updated.url || "",
			title: updated.title || "Untitled",
			favicon: updated.favIconUrl,
		};
		if (pinned) {
			details.pinnedTab = updated.id;
		} else {
			details.unpinnedTab = updated.id;
		}

		return {
			content: [
				{ type: "text", text: `${pinned ? "Pinned" : "Unpinned"} tab ${updated.id}: ${this.tabSummary(updated)}` },
			],
			details,
		};
	}

	private async moveTab(
		tabId: number,
		index: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tab = await this.getTab(tabId);
		const moved = await chrome.tabs.move(tab.id, { index });
		const movedTab = Array.isArray(moved) ? moved[0] : moved;
		if (!movedTab?.id) {
			throw new Error(`Failed to move tab ${tab.id}`);
		}
		return {
			content: [
				{ type: "text", text: `Moved tab ${movedTab.id} to index ${movedTab.index}: ${this.tabSummary(movedTab)}` },
			],
			details: {
				movedTab: movedTab.id,
				tabId: movedTab.id,
				finalUrl: movedTab.url || "",
				title: movedTab.title || "Untitled",
				favicon: movedTab.favIconUrl,
			},
		};
	}
}

// ============================================================================
// RENDERER
// ============================================================================

function getFallbackFavicon(url: string): string {
	try {
		const urlObj = new URL(url);
		return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
	} catch {
		return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23999' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
	}
}

export const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
	render(
		params: NavigateParams | undefined,
		result: ToolResultMessage<NavigateResult> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		// Loading state (params but no result)
		if (params && !result) {
			let displayText = "";
			if ("url" in params && params.url) {
				displayText = params.url;
			} else if ("listTabs" in params) {
				displayText = "Listing tabs...";
			} else if ("switchToTab" in params) {
				displayText = `Switching to tab ${params.switchToTab}`;
			}

			return {
				content: html`
					<div class="my-2">
						<div
							class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
						>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(Loader2, "sm", "animate-spin")}
							</div>
							<span class="truncate font-medium">${i18n("Navigating to")} ${displayText}</span>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Complete state (with result)
		if (result && !result.isError && result.details) {
			const { finalUrl, title, favicon, skills, tabs } = result.details;

			// Handle tab listing
			if (tabs) {
				return {
					content: html`
						<div class="flex items-center gap-2 flex-wrap">
							<span class="text-sm text-muted-foreground">${i18n("Open tabs")}</span>
							${tabs.map((tab) => TabPill(tab, true))}
						</div>
					`,
					isCustom: false,
				};
			}

			// Handle navigation/switch results
			if (finalUrl && title) {
				const faviconUrl = favicon || getFallbackFavicon(finalUrl);

				// Convert skills to Skill objects for SkillPill
				// Use fullDetails if available (for new/updated skills), otherwise create minimal skill
				const skillObjects: Skill[] = (skills || []).map((s) =>
					s.fullDetails
						? s.fullDetails
						: {
								name: s.name,
								shortDescription: s.shortDescription,
								description: "",
								examples: "",
								library: "",
								domainPatterns: [],
								createdAt: new Date().toISOString(),
								lastUpdated: new Date().toISOString(),
							},
				);

				return {
					content: html`
						<div class="my-2 space-y-2">
							<button
								class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg hover:bg-accent/50 transition-colors max-w-full cursor-pointer shadow-lg"
								@click=${() => chrome.tabs.create({ url: finalUrl })}
								title="${i18n("Click to open")}: ${finalUrl}"
							>
								<img src="${faviconUrl}" alt="" class="w-4 h-4 flex-shrink-0" />
								<span class="truncate font-medium">${title}</span>
							</button>
							${
								skillObjects.length > 0
									? html`
										<div class="flex flex-wrap gap-2">
											${skillObjects.map((s) => SkillPill(s, true))}
										</div>
								  `
									: ""
							}
						</div>
					`,
					isCustom: true,
				};
			}
		}

		// Error state
		if (result?.isError) {
			const errorText = result.content.find((c) => c.type === "text")?.text || "Unknown error";
			return {
				content: html`
					<div class="my-2">
						<div class="text-sm text-destructive">${errorText}</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Waiting state
		return {
			content: html`<div class="my-2 text-sm text-muted-foreground">${i18n("Waiting...")}</div>`,
			isCustom: true,
		};
	},
};

// Auto-register renderer
registerToolRenderer("navigate", navigateRenderer);
