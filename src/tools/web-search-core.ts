export type SearchProvider = "tinyfish" | "exa" | "parallel";
export type FreeSearchProvider = "exa-free" | "parallel-free";
export const SEARCH_PROVIDERS: SearchProvider[] = ["tinyfish", "exa", "parallel"];
export const searchKeyName = (provider: SearchProvider): string => `web-search-${provider}`;

type Result = { title: string; url: string; snippet: string; date?: string };
export type Details = { provider: SearchProvider | FreeSearchProvider; results: Result[]; fallbackFrom?: string[] };

function normalize(data: unknown): Result[] {
	if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) {
		throw new Error("Provider returned an invalid search response");
	}
	return data.results
		.flatMap((item: unknown): Result[] => {
			if (!item || typeof item !== "object") return [];
			const row = item as Record<string, unknown>;
			if (typeof row.url !== "string" || !/^https?:\/\//i.test(row.url)) return [];
			const excerpts = row.excerpts ?? row.highlights;
			const snippet =
				typeof row.snippet === "string"
					? row.snippet
					: typeof row.text === "string"
						? row.text
						: Array.isArray(excerpts)
							? excerpts.filter((x): x is string => typeof x === "string").join("\n")
							: "";
			const date = row.date ?? row.publishedDate ?? row.publish_date;
			return [
				{
					title: typeof row.title === "string" ? row.title : row.url,
					url: row.url,
					snippet: snippet.slice(0, 4000),
					...(typeof date === "string" ? { date } : {}),
				},
			];
		})
		.slice(0, 10);
}

export async function searchProvider(
	provider: SearchProvider,
	key: string,
	query: string,
	signal?: AbortSignal,
): Promise<Result[]> {
	const url =
		provider === "tinyfish"
			? `https://api.search.tinyfish.ai/?${new URLSearchParams({ query })}`
			: provider === "exa"
				? "https://api.exa.ai/search"
				: "https://api.parallel.ai/v1/search";
	const body =
		provider === "exa"
			? { query, type: "auto", numResults: 10 }
			: { objective: query, search_queries: [query], mode: "fast" };
	const response = await fetch(url, {
		method: provider === "tinyfish" ? "GET" : "POST",
		headers: { "x-api-key": key, ...(provider === "tinyfish" ? {} : { "content-type": "application/json" }) },
		...(provider === "tinyfish" ? {} : { body: JSON.stringify(body) }),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
	return normalize(await response.json());
}

let freeSessionId: string | undefined;

export async function searchFree(provider: FreeSearchProvider, query: string, signal?: AbortSignal): Promise<Result[]> {
	freeSessionId ??= crypto.randomUUID();
	const parallel = provider === "parallel-free";
	const endpoint = parallel ? "https://search.parallel.ai/mcp" : "https://mcp.exa.ai/mcp";
	const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
	let transportSession: string | null = null;
	let protocol = "2025-06-18";
	if (parallel) {
		const init = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: protocol,
					capabilities: {},
					clientInfo: { name: "openclaw-parallel", version: "2026.10.10" },
				},
			}),
			signal: timeout,
		});
		if (!init.ok) throw new Error(`${provider} initialize returned HTTP ${init.status}`);
		transportSession = init.headers.get("mcp-session-id");
		const initBody = await init.text();
		const initPayload = initBody.trimStart().startsWith("{")
			? initBody
			: initBody
					.split(/\r?\n/)
					.find((line) => line.startsWith("data:"))
					?.slice(5)
					.trim();
		if (!initPayload) throw new Error(`${provider} returned invalid initialization`);
		const initResult: unknown = JSON.parse(initPayload);
		if (
			!initResult ||
			typeof initResult !== "object" ||
			!("result" in initResult) ||
			!initResult.result ||
			typeof initResult.result !== "object"
		)
			throw new Error(`${provider} initialization failed`);
		if ("protocolVersion" in initResult.result && typeof initResult.result.protocolVersion === "string")
			protocol = initResult.result.protocolVersion;
		const notification = await fetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": protocol,
				...(transportSession ? { "Mcp-Session-Id": transportSession } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			signal: timeout,
		});
		if (!notification.ok)
			throw new Error(`${provider} initialization notification returned HTTP ${notification.status}`);
	}
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(parallel
				? { "MCP-Protocol-Version": protocol, ...(transportSession ? { "Mcp-Session-Id": transportSession } : {}) }
				: {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: parallel ? "web_search" : "web_search_exa",
				arguments: parallel
					? { objective: query, search_queries: [query], session_id: freeSessionId }
					: { query, numResults: 10 },
			},
		}),
		signal: timeout,
	});
	if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}`);
	const body = await response.text();
	const payload = body.trimStart().startsWith("{")
		? body
		: body
				.split(/\r?\n/)
				.find((line) => line.startsWith("data:"))
				?.slice(5)
				.trim();
	if (!payload) throw new Error(`${provider} returned an invalid MCP response`);
	const envelope: unknown = JSON.parse(payload);
	if (!envelope || typeof envelope !== "object" || !("result" in envelope))
		throw new Error(`${provider} returned an MCP error`);
	const result = envelope.result;
	if (
		!result ||
		typeof result !== "object" ||
		!("content" in result) ||
		!Array.isArray(result.content) ||
		("isError" in result && result.isError)
	)
		throw new Error(`${provider} search failed`);
	const text = result.content.find(
		(part: unknown) => part && typeof part === "object" && "text" in part && typeof part.text === "string",
	)?.text;
	if (typeof text !== "string") throw new Error(`${provider} returned no search content`);
	if (parallel) return normalize(JSON.parse(text));
	const rows = text.split(/\n\s*---\s*\n/).map((block) => {
		const title = block.match(/^Title:\s*(.*)$/m)?.[1] ?? "";
		const url = block.match(/^URL:\s*(.*)$/m)?.[1] ?? "";
		const snippet = block.match(/^Highlights:\s*([\s\S]*)/m)?.[1] ?? "";
		return { title, url, snippet };
	});
	return normalize({ results: rows });
}

let nextProvider = 0;
let nextFreeProvider = 0;
export async function routeSearch(
	query: string,
	keys: Partial<Record<SearchProvider, string>>,
	signal?: AbortSignal,
): Promise<Details> {
	const providers = SEARCH_PROVIDERS.filter((provider) => !!keys[provider]);
	const errors: string[] = [];
	if (providers.length) {
		const start = nextProvider++ % providers.length;
		for (let i = 0; i < providers.length; i++) {
			if (signal?.aborted) throw new Error("Search cancelled");
			const provider = providers[(start + i) % providers.length];
			try {
				return { provider, results: await searchProvider(provider, keys[provider] as string, query, signal) };
			} catch (error) {
				if (signal?.aborted) throw new Error("Search cancelled");
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	}
	const free: FreeSearchProvider[] = ["parallel-free", "exa-free"];
	const start = nextFreeProvider++ % free.length;
	for (let i = 0; i < free.length; i++) {
		if (signal?.aborted) throw new Error("Search cancelled");
		const provider = free[(start + i) % free.length];
		try {
			return {
				provider,
				results: await searchFree(provider, query, signal),
				...(errors.length ? { fallbackFrom: errors } : {}),
			};
		} catch (error) {
			if (signal?.aborted) throw new Error("Search cancelled");
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(`Search failed: ${errors.join("; ")}`);
}
