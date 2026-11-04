import { bytes, saveFile } from "./packets.js";
import { attach, command, target } from "./page.js";
import { all, errorText, get, publicUrl, put, redact, required } from "./store.js";

export interface Capture {
	id: string;
	tabId: number;
	origin: string;
	pattern: string;
	active: boolean;
	createdAt: number;
	maxBodyBytes: number;
	maxRecords: number;
	download?: { packet: string; name: string };
	error?: string;
}
export interface NetworkRecord {
	id: string;
	captureId: string;
	requestId: string;
	tabId: number;
	sessionId?: string;
	url: string;
	method?: string;
	resourceType?: string;
	requestBody?: unknown;
	status?: number;
	mime?: string;
	headers?: unknown;
	body?: string;
	base64Encoded?: boolean;
	bodyError?: string;
	finished?: boolean;
	time: number;
}
export function matches(pattern: string, url: string): boolean {
	return new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	).test(url);
}
const starting = new Set<number>();
export async function startCapture(options: Parameters<typeof startCaptureInner>[0]) {
	if (starting.has(options.tabId)) throw new Error("Capture setup is already running on this tab");
	starting.add(options.tabId);
	try {
		return await startCaptureInner(options);
	} finally {
		starting.delete(options.tabId);
	}
}
async function startCaptureInner(options: {
	tabId: number;
	pattern?: string;
	maxBodyBytes?: number;
	maxRecords?: number;
	download?: Capture["download"];
}) {
	const tab = await target(options.tabId);
	const existing = (await all<Capture>("captures")).find((c) => c.tabId === options.tabId && c.active);
	if (existing) throw new Error(`Capture already active on this tab: ${existing.id}`);
	const capture: Capture = {
		id: crypto.randomUUID(),
		tabId: options.tabId,
		origin: new URL(tab.url!).origin,
		pattern: options.pattern ?? `${new URL(tab.url!).origin}/*`,
		active: true,
		createdAt: Date.now(),
		maxBodyBytes: Math.min(Math.max(options.maxBodyBytes ?? 16_000_000, 1), 64_000_000),
		maxRecords: Math.min(Math.max(options.maxRecords ?? 1000, 1), 10000),
		download: options.download,
	};
	await attach(capture.tabId);
	await put("captures", capture);
	try {
		await command(capture.tabId, "Network.enable", {
			maxTotalBufferSize: 100_000_000,
			maxResourceBufferSize: capture.maxBodyBytes,
		});
		await command(capture.tabId, "Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		if (capture.download)
			await command(capture.tabId, "Fetch.enable", {
				patterns: [{ urlPattern: capture.pattern, requestStage: "Response" }],
			});
	} catch (error) {
		await command(capture.tabId, "Fetch.disable").catch(() => undefined);
		await command(capture.tabId, "Network.disable").catch(() => undefined);
		await command(capture.tabId, "Target.setAutoAttach", {
			autoAttach: false,
			waitForDebuggerOnStart: false,
			flatten: true,
		}).catch(() => undefined);
		await put("captures", { ...capture, active: false, error: errorText(error) });
		throw error;
	}
	return capture;
}
export async function stopCapture(id: string) {
	const capture = await required<Capture>("captures", id);
	if (capture.download) await command(capture.tabId, "Fetch.disable");
	await command(capture.tabId, "Network.disable");
	await command(capture.tabId, "Target.setAutoAttach", {
		autoAttach: false,
		waitForDebuggerOnStart: false,
		flatten: true,
	});
	return put("captures", { ...capture, active: false });
}
export async function listResponses(captureId: string) {
	return (await all<NetworkRecord>("responses"))
		.filter((record) => record.captureId === captureId)
		.map(({ body: _, ...record }) => record);
}
export async function responseBody(id: string) {
	const meta = await required<NetworkRecord>("responses", id);
	const record = { ...meta, ...(await get<{ body: string; base64Encoded: boolean }>("response-bodies", id)) };
	if (record.bodyError || record.body === undefined) throw new Error(record.bodyError ?? "Response body not ready");
	if (record.base64Encoded && !record.mime?.includes("json")) return { id, mime: record.mime, base64: record.body };
	const text = record.base64Encoded ? new TextDecoder().decode(bytes(record.body)) : record.body;
	let body: unknown = text;
	try {
		body = redact(JSON.parse(text));
	} catch {
		/* Text responses have no structured fields. */
	}
	return { id, mime: record.mime, body };
}
export async function saveResponse(id: string, packet: string, name: string) {
	const meta = await required<NetworkRecord>("responses", id);
	const record = { ...meta, ...(await get<{ body: string; base64Encoded: boolean }>("response-bodies", id)) };
	if (record.bodyError || record.body === undefined) throw new Error(record.bodyError ?? "Body not ready");
	let content = record.body;
	if (record.mime?.includes("json")) {
		content = JSON.stringify(
			redact(JSON.parse(record.base64Encoded ? new TextDecoder().decode(bytes(content)) : content)),
			null,
			2,
		);
		return saveFile(packet, name, content, record.mime, "text");
	}
	return saveFile(packet, name, content, record.mime, record.base64Encoded ? "base64" : "text");
}
export async function replayResponse(id: string) {
	const record = await required<NetworkRecord>("responses", id);
	const capture = await required<Capture>("captures", record.captureId);
	await target(record.tabId, capture.origin);
	if (record.resourceType !== "XHR")
		throw new Error("Native replay is available only for XHR; use a MAIN-world request adapter for fetch calls");
	if (record.method !== "GET" && record.method !== "HEAD")
		throw new Error("Replay only supports read requests; call a saved page tool explicitly for writes");
	await chrome.debugger.sendCommand({ tabId: record.tabId, sessionId: record.sessionId }, "Network.replayXHR", {
		requestId: record.requestId,
	});
	return { replayed: id, captureId: record.captureId };
}
interface EventData {
	requestId: string;
	type?: string;
	encodedDataLength?: number;
	errorText?: string;
	request?: { url: string; method: string; postData?: string };
	response?: { url: string; status: number; mimeType: string; headers: Record<string, string> };
	sessionId?: string;
	responseStatusCode?: number;
	responseHeaders?: { name: string; value: string }[];
}
const queues = new Map<number, Promise<void>>();
export function networkEvent(source: chrome.debugger.DebuggerSession, method: string, raw?: object): void {
	if (
		source.tabId === undefined ||
		![
			"Network.requestWillBeSent",
			"Network.responseReceived",
			"Network.loadingFinished",
			"Network.loadingFailed",
			"Fetch.requestPaused",
			"Target.attachedToTarget",
		].includes(method)
	)
		return;
	const tabId = source.tabId;
	const next = (queues.get(tabId) ?? Promise.resolve())
		.then(() => processEvent(source, method, raw as EventData))
		.catch(async (error) => {
			const capture = (await all<Capture>("captures")).find((c) => c.active && c.tabId === tabId);
			if (capture) await put("captures", { ...capture, error: errorText(error) });
		});
	queues.set(tabId, next);
	void next.finally(() => {
		if (queues.get(tabId) === next) queues.delete(tabId);
	});
}
async function processEvent(source: chrome.debugger.DebuggerSession, method: string, event: EventData) {
	const capture = (await all<Capture>("captures")).find((c) => c.active && c.tabId === source.tabId);
	if (method === "Target.attachedToTarget" && event.sessionId && capture) {
		const child = { ...source, sessionId: event.sessionId };
		await chrome.debugger.sendCommand(child, "Network.enable", { maxResourceBufferSize: capture.maxBodyBytes });
		await chrome.debugger.sendCommand(child, "Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		if (capture.download)
			await chrome.debugger.sendCommand(child, "Fetch.enable", {
				patterns: [{ urlPattern: capture.pattern, requestStage: "Response" }],
			});
		return;
	}
	if (method === "Fetch.requestPaused") {
		try {
			if (
				capture?.download &&
				event.responseStatusCode &&
				event.responseStatusCode >= 200 &&
				event.responseStatusCode < 300
			) {
				const headers = event.responseHeaders ?? [];
				const mime =
					headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "application/octet-stream";
				const disposition = headers.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
				if (mime.includes("pdf") || /attachment/i.test(disposition)) {
					const body = (await chrome.debugger.sendCommand(source, "Fetch.getResponseBody", {
						requestId: event.requestId,
					})) as { body: string; base64Encoded: boolean };
					if (body.body.length > capture.maxBodyBytes * (body.base64Encoded ? 4 / 3 : 1))
						throw new Error("Download exceeds capture limit");
					await saveFile(
						capture.download.packet,
						capture.download.name,
						body.body,
						mime,
						body.base64Encoded ? "base64" : "text",
					);
				}
			}
		} finally {
			// Always release the original response, including failed packet writes.
			await chrome.debugger.sendCommand(source, "Fetch.continueRequest", { requestId: event.requestId });
		}
		return;
	}
	if (!capture || !event?.requestId) return;
	const id = `${capture.id}:${source.sessionId ?? "root"}:${event.requestId}`;
	let record = await get<NetworkRecord>("responses", id);
	if (method === "Network.requestWillBeSent" && event.request && matches(capture.pattern, event.request.url)) {
		if ((await listResponses(capture.id)).length >= capture.maxRecords && !record)
			throw new Error("Capture record limit reached; stop and start another capture");
		let requestBody: unknown;
		if (event.request.postData) {
			try {
				requestBody = redact(JSON.parse(event.request.postData));
			} catch {
				requestBody = "[non-JSON request body withheld]";
			}
		}
		record = {
			id,
			captureId: capture.id,
			requestId: event.requestId,
			tabId: capture.tabId,
			sessionId: source.sessionId,
			url: publicUrl(event.request.url),
			method: event.request.method,
			resourceType: event.type,
			requestBody,
			time: Date.now(),
		};
		await put("responses", record);
	} else if (record && method === "Network.responseReceived" && event.response) {
		await put("responses", {
			...record,
			status: event.response.status,
			mime: event.response.mimeType,
			headers: redact(event.response.headers),
			url: publicUrl(event.response.url),
		});
	} else if (record && method === "Network.loadingFinished") {
		try {
			if ((event.encodedDataLength ?? 0) > capture.maxBodyBytes)
				throw new Error("Response exceeds capture size limit");
			const body = (await chrome.debugger.sendCommand(source, "Network.getResponseBody", {
				requestId: event.requestId,
			})) as { body: string; base64Encoded: boolean };
			if (body.body.length > capture.maxBodyBytes * (body.base64Encoded ? 4 / 3 : 1))
				throw new Error("Decoded response exceeds capture limit");
			await put("response-bodies", { id, ...body });
			await put("responses", { ...record, finished: true });
		} catch (error) {
			await put("responses", { ...record, bodyError: errorText(error), finished: true });
		}
	} else if (record && method === "Network.loadingFailed") {
		await put("responses", { ...record, bodyError: event.errorText ?? "Network request failed", finished: true });
	}
}
