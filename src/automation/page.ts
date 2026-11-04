import { publicUrl, redact } from "./store.js";

export async function target(tabId: number, origin?: string): Promise<chrome.tabs.Tab> {
	if (!Number.isInteger(tabId)) throw new Error("An explicit tabId is required");
	const tab = await chrome.tabs.get(tabId);
	if (!tab.url || !/^https?:/.test(tab.url)) throw new Error("Target must be an HTTP(S) page");
	if (origin && new URL(tab.url).origin !== origin)
		throw new Error("Target origin changed; refusing to reuse authentication on another site");
	return tab;
}
export async function attach(tabId: number): Promise<void> {
	await target(tabId);
	try {
		await chrome.debugger.attach({ tabId }, "1.3");
	} catch (error) {
		if (!String(error).toLowerCase().includes("already attached")) throw error;
	}
}
export async function command<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
	return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}
export interface Evaluation {
	tabId: number;
	expression: string;
	origin?: string;
	frameId?: string;
	contextId?: number;
	world?: "MAIN" | "ISOLATED";
}
export async function evaluate(args: Evaluation): Promise<unknown> {
	await target(args.tabId, args.origin);
	await attach(args.tabId);
	let contextId: number | undefined = args.contextId;
	if (args.world === "ISOLATED") {
		const tree = await command<{ frameTree: { frame: { id: string } } }>(args.tabId, "Page.getFrameTree");
		const result = await command<{ executionContextId: number }>(args.tabId, "Page.createIsolatedWorld", {
			frameId: args.frameId ?? tree.frameTree.frame.id,
			worldName: "sitegeist-automation",
		});
		contextId = result.executionContextId;
	} else if (args.frameId) {
		const contexts = await pageContexts(args.tabId);
		contextId = contexts.find((context) => context.frameId === args.frameId && context.isDefault)?.id;
		if (contextId === undefined) throw new Error("No MAIN execution context for this frame; inspect page.contexts");
	}
	const response = await command<{
		result: { value?: unknown; description?: string; subtype?: string };
		exceptionDetails?: unknown;
	}>(args.tabId, "Runtime.evaluate", {
		expression: args.origin
			? `(() => { if (location.origin !== ${JSON.stringify(args.origin)}) throw new Error("Target origin changed"); return (${args.expression}); })()`
			: args.expression,
		awaitPromise: true,
		returnByValue: true,
		timeout: 25000,
		...(contextId === undefined ? {} : { contextId }),
	});
	if (response.exceptionDetails)
		throw new Error("Page execution failed (details withheld to avoid leaking credentials)");
	if (response.result.subtype === "error") throw new Error("Page execution returned an error");
	return redact(response.result.value);
}
export interface PageRequest {
	tabId: number;
	origin: string;
	url: string;
	method?: string;
	body?: string;
	headers?: Record<string, string>;
	adapter?: string;
	input?: unknown;
}
// The adapter is a function expression evaluated in MAIN. It must return Response,
// or a serializable result; session secrets never need to cross the bridge.
export async function request(args: PageRequest): Promise<unknown> {
	const method = args.method ?? "GET";
	const url = new URL(args.url, args.origin);
	if (url.origin !== args.origin)
		throw new Error(
			"Authenticated request must stay on the declared origin; use a page adapter for the site's own cross-origin client",
		);
	if (Object.keys(args.headers ?? {}).some((key) => /authorization|cookie|token|csrf/i.test(key)))
		throw new Error("Keep authentication inside a page adapter, not tool arguments");
	const config = JSON.stringify({ url: url.href, method, body: args.body, headers: args.headers, input: args.input });
	return evaluate({
		tabId: args.tabId,
		origin: args.origin,
		expression: `(async () => {
		const config = ${config};
		const result = ${args.adapter ? `await (${args.adapter})(config)` : 'await fetch(config.url, { method: config.method, body: config.body, headers: config.headers, credentials: "include", signal: AbortSignal.timeout(20000) })'};
		if (!(result instanceof Response)) return result;
		const type = result.headers.get("content-type") || "";
		if (!result.ok) return {status: result.status, ok: false, contentType: type};
		const text = await result.text();
		if (text.length > 2000000) throw new Error("Response too large; use network capture");
		return {status: result.status, ok: result.ok, contentType: type, body: type.includes("json") ? JSON.parse(text) : text};
	})()`,
	});
}
export async function navigate(tabId: number, url: string): Promise<{ tabId: number; url: string }> {
	if (!/^https?:/.test(url)) throw new Error("Only HTTP(S) navigation is supported");
	await chrome.tabs.update(tabId, { url });
	const end = Date.now() + 25000;
	while (Date.now() < end) {
		const tab = await chrome.tabs.get(tabId);
		if (tab.status === "complete" && tab.url !== "about:blank") return { tabId, url: publicUrl(tab.url ?? url) };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Navigation timed out");
}

export interface PageContext {
	id: number;
	uniqueId?: string;
	name: string;
	origin: string;
	frameId?: string;
	isDefault?: boolean;
}
export async function pageContexts(tabId: number): Promise<PageContext[]> {
	await attach(tabId);
	const contexts = new Map<number, PageContext>();
	const listener = (source: chrome.debugger.DebuggerSession, method: string, data?: object) => {
		if (source.tabId !== tabId || source.sessionId || method !== "Runtime.executionContextCreated") return;
		const context = (
			data as {
				context: {
					id: number;
					uniqueId?: string;
					name: string;
					origin: string;
					auxData?: { frameId?: string; isDefault?: boolean };
				};
			}
		).context;
		contexts.set(context.id, {
			...context,
			frameId: context.auxData?.frameId,
			isDefault: context.auxData?.isDefault,
		});
	};
	chrome.debugger.onEvent.addListener(listener);
	try {
		await command(tabId, "Runtime.disable");
		await command(tabId, "Runtime.enable");
		await new Promise((resolve) => setTimeout(resolve, 100));
		return [...contexts.values()];
	} finally {
		chrome.debugger.onEvent.removeListener(listener);
	}
}
