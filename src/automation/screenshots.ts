import { saveFile } from "./packets.js";
import { attach, command, evaluate, target } from "./page.js";
import { publicUrl, safeName } from "./store.js";

export interface ScreenshotOptions {
	tabId: number;
	packet: string;
	orderId: string;
	readySelector?: string;
	rowSelector?: string;
	expectedRows?: number;
	addressSelector?: string;
}
export async function screenshot(options: ScreenshotOptions) {
	const { tabId } = options;
	const tab = await target(tabId);
	const origin = new URL(tab.url!).origin;
	await attach(tabId);
	const evidence = await evaluate({
		tabId,
		origin,
		expression: `(async () => {
		const opts = ${JSON.stringify(options)};
		const deadline = Date.now() + 20000;
		while (document.readyState !== 'complete' || (opts.readySelector && !document.querySelector(opts.readySelector))) {
			if (Date.now() > deadline) throw new Error('Page not ready');
			await new Promise(r => setTimeout(r, 100));
		}
		await Promise.race([document.fonts.ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Fonts not ready")), 5000))]);
		const original = { x: scrollX, y: scrollY };
		const seen = new Set();
		try {
			for (let y = 0; y < document.documentElement.scrollHeight; y += Math.max(200, innerHeight * .8)) {
				if (Date.now() > deadline) throw new Error('Page loading exceeded screenshot budget');
				scrollTo(0, y);
				await new Promise(r => setTimeout(r, 100));
				if (opts.rowSelector) document.querySelectorAll(opts.rowSelector).forEach(el => seen.add(el.textContent));
			}
			await Promise.race([Promise.all([...document.images].filter(i => i.getBoundingClientRect().width).map(i => i.decode())), new Promise((_,reject) => setTimeout(() => reject(new Error("Images not ready")), 5000))]);
			const unclipped = el => {
				const rect = el.getBoundingClientRect();
				if (!rect.width || !rect.height) return false;
				for (let parent=el.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent=parent.parentElement) {
					const box = parent.getBoundingClientRect(), style = getComputedStyle(parent);
					if (/(hidden|clip|auto|scroll)/.test(style.overflowY) && (rect.top < box.top-2 || rect.bottom > box.bottom+2)) return false;
					if (/(hidden|clip|auto|scroll)/.test(style.overflowX) && (rect.left < box.left-2 || rect.right > box.right+2)) return false;
				}
				return true;
			};
			if (opts.rowSelector && [...document.querySelectorAll(opts.rowSelector)].some(el => !unclipped(el))) throw new Error('Rows are hidden or clipped in a nested container');
			const rows = opts.rowSelector ? document.querySelectorAll(opts.rowSelector).length : null;
			if (opts.expectedRows !== undefined && rows !== opts.expectedRows) throw new Error('Rendered row count mismatch');
			if (rows !== null && seen.size > rows) throw new Error('Virtualized rows detected; expand all rows or capture separate pages');
			const address = opts.addressSelector ? document.querySelector(opts.addressSelector) : null;
			if (opts.addressSelector && (!address || !address.textContent.trim() || !unclipped(address) || address.scrollHeight > address.clientHeight + 2 || address.scrollWidth > address.clientWidth + 2)) throw new Error('Address missing or clipped');
			return { rows, expectedRows: opts.expectedRows, address: address?.textContent.trim(), title: document.title, url: location.href, height: document.documentElement.scrollHeight };
		} finally { scrollTo(original.x, original.y); }
	})()`,
	});
	const metrics = await command<{ cssContentSize: { width: number; height: number } }>(tabId, "Page.getLayoutMetrics");
	const { width, height } = metrics.cssContentSize;
	if (width * height > 80_000_000 || height > 50000)
		throw new Error("Page exceeds screenshot limits; split into sections");
	const result = await command<{ data: string }>(tabId, "Page.captureScreenshot", {
		format: "png",
		captureBeyondViewport: true,
		fromSurface: true,
		clip: { x: 0, y: 0, width, height, scale: 1 },
	});
	const stem = safeName(options.orderId);
	const file = await saveFile(options.packet, `${stem}.png`, result.data, "image/png");
	await saveFile(
		options.packet,
		`${stem}.screenshot.json`,
		JSON.stringify(
			{ evidence, width, height, url: publicUrl(tab.url!), capturedAt: Date.now(), checks: options },
			null,
			2,
		),
		"application/json",
		"text",
	);
	return file;
}
