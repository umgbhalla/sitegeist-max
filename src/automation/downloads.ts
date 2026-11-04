import { saveFile } from "./packets.js";
import { evaluate, target } from "./page.js";

export async function fetchDownload(options: {
	tabId: number;
	origin: string;
	url: string;
	packet: string;
	name: string;
	adapter?: string;
	input?: unknown;
}) {
	await target(options.tabId, options.origin);
	const url = new URL(options.url, options.origin);
	if (url.origin !== options.origin)
		throw new Error(
			"Download URL must belong to the signed-in origin; use response capture for cross-origin redirects",
		);
	const config = JSON.stringify({ url: url.href, input: options.input });
	const result = (await evaluate({
		tabId: options.tabId,
		origin: options.origin,
		expression: `(async () => {
		const config = ${config};
		const response = ${options.adapter ? `await (${options.adapter})(config)` : 'await fetch(config.url, {credentials:"include", signal:AbortSignal.timeout(20000)})'};
		if (!(response instanceof Response) || !response.ok) throw new Error('Download response failed');
		const data = new Uint8Array(await response.arrayBuffer());
		if (data.length > 64000000) throw new Error('Download too large');
		let binary = ''; for (let i=0; i<data.length; i+=8192) binary += String.fromCharCode(...data.subarray(i,i+8192));
		return {data: btoa(binary), mime: response.headers.get('content-type') || 'application/octet-stream'};
	})()`,
	})) as { data: string; mime: string };
	return saveFile(options.packet, options.name, result.data, result.mime);
}
