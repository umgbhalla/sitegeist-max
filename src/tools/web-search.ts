import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@earendil-works/pi-ai";
import { getAppStorage, registerToolRenderer, renderHeader, renderSources } from "@earendil-works/pi-web-ui";
import { i18n } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Search } from "lucide";
import "../utils/i18n-extension.js";

import { type Details, routeSearch, SEARCH_PROVIDERS, searchKeyName } from "./web-search-core.js";

const schema = Type.Object({ query: Type.String({ description: "Search query or research objective" }) });
type Params = Static<typeof schema>;

// Session rules only affect this extension's requests to the two MCP endpoints.
let clientHeadersReady: Promise<void> | undefined;
function ensureClientHeaders(): Promise<void> {
	clientHeadersReady ??= (async () => {
		const { os } = await chrome.runtime.getPlatformInfo();
		const platform = os === "mac" ? "darwin" : os === "win" ? "win32" : os;
		const ids = [901001, 901002];
		await chrome.declarativeNetRequest.updateSessionRules({
			removeRuleIds: ids,
			addRules: [
				{
					id: ids[0],
					priority: 1,
					action: {
						type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
						requestHeaders: [
							{
								header: "User-Agent",
								operation: chrome.declarativeNetRequest.HeaderOperation.SET,
								value: `openclaw-parallel/2026.10.10 (${platform})`,
							},
						],
					},
					condition: {
						regexFilter: "^https://search\\.parallel\\.ai/mcp(?:[?#]|$)",
						initiatorDomains: [chrome.runtime.id],
						resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
					},
				},
				{
					id: ids[1],
					priority: 1,
					action: {
						type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
						requestHeaders: [
							{
								header: "User-Agent",
								operation: chrome.declarativeNetRequest.HeaderOperation.SET,
								value: "hermes-agent",
							},
						],
					},
					condition: {
						regexFilter: "^https://mcp\\.exa\\.ai/mcp(?:[?#]|$)",
						initiatorDomains: [chrome.runtime.id],
						resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
					},
				},
			],
		});
	})().catch((error: unknown) => {
		clientHeadersReady = undefined;
		throw error;
	});
	return clientHeadersReady;
}

export class WebSearchTool implements AgentTool<typeof schema, Details> {
	name = "web_search";
	label = "Web Search";
	description =
		"Search the public web using configured TinyFish, Exa or Parallel providers, with free keyless Exa and Parallel fallback. Results include source URLs and snippets. Cite sources and inspect pages when needed. Provider usage may incur charges.";
	parameters = schema;
	async execute(_id: string, args: Params, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		const query = args.query.trim();
		if (!query || query.length > 2000) throw new Error("Search query must contain 1 to 2000 characters");
		const pairs = await Promise.all(
			SEARCH_PROVIDERS.map(
				async (provider) => [provider, await getAppStorage().providerKeys.get(searchKeyName(provider))] as const,
			),
		);
		await ensureClientHeaders();
		const details = await routeSearch(query, Object.fromEntries(pairs), signal);
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}

registerToolRenderer("web_search", {
	render(params: Params | undefined, result) {
		const query = params?.query ? `"${params.query}"` : "";
		if (!result) {
			return { content: renderHeader("inprogress", Search, `${i18n("Searching")} ${query}`), isCustom: false };
		}
		if (result.isError) {
			const error = result.content.find((c) => c.type === "text")?.text ?? "";
			return {
				content: html`${renderHeader("error", Search, i18n("Search failed"))}
					<div class="text-sm text-destructive">${error}</div>`,
				isCustom: false,
			};
		}
		const results = (result.details as Details | undefined)?.results ?? [];
		return {
			content: html`${renderHeader("complete", Search, query)}
				<div class="step-meta">${i18n("{count} results").replace("{count}", String(results.length))}</div>
				${results.length > 0 ? renderSources(results.map((r) => ({ url: r.url, title: r.title }))) : ""}`,
			isCustom: false,
		};
	},
});
