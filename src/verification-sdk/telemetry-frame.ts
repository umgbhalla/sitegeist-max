import type { VerificationTelemetryRecorder } from "./telemetry.js";
import { telemetryUrl } from "./telemetry-redaction.js";

/** Read only the discovered challenge document; never inspect cookies or web storage. */
export async function captureVerificationFrame(
	tabId: number,
	frameId: number,
	phase: string,
	telemetry: VerificationTelemetryRecorder,
): Promise<void> {
	const [entry] = await chrome.scripting.executeScript({
		target: { tabId, frameIds: [frameId] },
		func: () => {
			const root = document.querySelector("#tcWrap") ?? document.querySelector("#slideBg")?.parentElement;
			if (!root) return null;
			const safeUrl = (value: string) => {
				try {
					const u = new URL(value, location.href);
					return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : `[${u.protocol} omitted]`;
				} catch {
					return "[URL omitted]";
				}
			};
			const rect = (node: Element) => {
				const r = node.getBoundingClientRect();
				return { x: r.x, y: r.y, width: r.width, height: r.height };
			};
			const clone = root.cloneNode(true) as Element;
			for (const node of clone.querySelectorAll("script,input,textarea,select,object,embed")) node.remove();
			for (const node of Array.from(clone.querySelectorAll("*")).slice(2000)) node.remove();
			for (const node of [clone, ...Array.from(clone.querySelectorAll("*")).slice(0, 2000)]) {
				for (const attribute of Array.from(node.attributes)) {
					if (/^(?:src|href)$/.test(attribute.name)) node.setAttribute(attribute.name, safeUrl(attribute.value));
					else if (attribute.name === "style")
						node.setAttribute(
							"style",
							attribute.value.replace(
								/url\(["']?(.*?)["']?\)/g,
								(_match, url: string) => `url(${safeUrl(url)})`,
							),
						);
					else if (!/^(?:id|class|role|style|width|height|type|aria-label|aria-hidden)$/.test(attribute.name))
						node.removeAttribute(attribute.name);
				}
			}
			const omissions: string[] = [];
			const countLimit = (label: string, count: number, limit: number) => {
				if (count > limit) omissions.push(`${label}: ${count - limit} omitted`);
			};
			countLimit("DOM elements", root.querySelectorAll("*").length, 2000);
			countLimit("Snapshot HTML characters", clone.outerHTML.length, 150_000);
			countLimit(
				"Instruction characters",
				document.querySelector("#instructionText")?.textContent?.length ?? 0,
				500,
			);
			countLimit(
				"Element records",
				root.querySelectorAll("#slideBg,.tc-instruction-icon,.tc-click-mark,.verify-btn,canvas,img").length,
				100,
			);
			countLimit("Canvas records", root.querySelectorAll("canvas").length, 4);
			countLimit("Script records", document.scripts.length, 16);
			countLimit("Stylesheet records", document.styleSheets.length, 12);
			countLimit("Resource records", performance.getEntriesByType("resource").length, 150);
			for (const [index, script] of Array.from(document.scripts).slice(0, 16).entries())
				if (!script.src) countLimit(`Inline script ${index} characters`, script.textContent?.length ?? 0, 150_000);
			for (const [index, sheet] of Array.from(document.styleSheets).slice(0, 12).entries()) {
				try {
					countLimit(`Stylesheet ${index} rules`, sheet.cssRules.length, 300);
					countLimit(
						`Stylesheet ${index} characters`,
						Array.from(sheet.cssRules)
							.slice(0, 300)
							.map((rule) => rule.cssText)
							.join("\n").length,
						100_000,
					);
				} catch {
					omissions.push(`Stylesheet ${index} rules are not readable`);
				}
			}
			for (const [index, canvas] of Array.from(root.querySelectorAll("canvas")).slice(0, 4).entries())
				if (canvas.width * canvas.height > 2_000_000) omissions.push(`Canvas ${index} exceeds pixel limit`);
			return {
				omissions,
				url: safeUrl(location.href),
				viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
				instruction: document.querySelector("#instructionText")?.textContent?.slice(0, 500),
				html: clone.outerHTML.slice(0, 150_000),
				elements: Array.from(
					root.querySelectorAll("#slideBg,.tc-instruction-icon,.tc-click-mark,.verify-btn,canvas,img"),
				)
					.slice(0, 100)
					.map((node) => {
						const style = getComputedStyle(node);
						return {
							tag: node.tagName,
							id: node.id,
							className: node.getAttribute("class"),
							rect: rect(node),
							backgroundImage: style.backgroundImage.replace(
								/url\(["']?(.*?)["']?\)/g,
								(_match, url: string) => `url(${safeUrl(url)})`,
							),
							backgroundSize: style.backgroundSize,
							backgroundPosition: style.backgroundPosition,
							filter: style.filter,
							transform: style.transform,
							opacity: style.opacity,
							image:
								node instanceof HTMLImageElement
									? {
											src: safeUrl(node.currentSrc),
											naturalWidth: node.naturalWidth,
											naturalHeight: node.naturalHeight,
										}
									: undefined,
						};
					}),
				canvases: Array.from(root.querySelectorAll("canvas"))
					.slice(0, 4)
					.map((canvas) => {
						try {
							return {
								width: canvas.width,
								height: canvas.height,
								data: canvas.width * canvas.height <= 2_000_000 ? canvas.toDataURL("image/png") : undefined,
							};
						} catch {
							return { width: canvas.width, height: canvas.height, error: "Canvas pixels are not readable" };
						}
					}),
				scripts: Array.from(document.scripts)
					.slice(0, 16)
					.map((script) => ({
						src: script.src ? safeUrl(script.src) : undefined,
						queryOmitted: Boolean(script.src && new URL(script.src).search),
						type: script.type,
						inline: script.src ? undefined : script.textContent?.slice(0, 150_000),
					})),
				stylesheets: Array.from(document.styleSheets)
					.slice(0, 12)
					.map((sheet) => {
						try {
							return {
								href: sheet.href ? safeUrl(sheet.href) : undefined,
								css: Array.from(sheet.cssRules)
									.slice(0, 300)
									.map((rule) => rule.cssText)
									.join("\n")
									.slice(0, 100_000),
							};
						} catch {
							return {
								href: sheet.href ? safeUrl(sheet.href) : undefined,
								error: "Stylesheet rules are not readable",
							};
						}
					}),
				resources: performance
					.getEntriesByType("resource")
					.slice(-150)
					.map((resource) => ({
						url: safeUrl(resource.name),
						durationMs: Math.round(resource.duration),
						initiatorType: resource instanceof PerformanceResourceTiming ? resource.initiatorType : undefined,
						transferSize: resource instanceof PerformanceResourceTiming ? resource.transferSize : undefined,
					})),
			};
		},
	});
	const snapshot = entry?.result;
	if (!snapshot) {
		telemetry.warn(`Frame snapshot unavailable: ${phase}`);
		return;
	}
	for (const omission of snapshot.omissions) telemetry.warn(`${phase} snapshot: ${omission}`);
	telemetry.event("iframe_snapshot", {
		phase,
		frameId,
		url: snapshot.url,
		viewport: snapshot.viewport,
		instruction: snapshot.instruction,
		elements: snapshot.elements,
		scripts: snapshot.scripts.map(({ inline, ...script }) => ({ ...script, inlineLength: inline?.length })),
		resources: snapshot.resources,
	});
	telemetry.text(`${phase}/iframe.html`, snapshot.html, "text/html", { sanitized: true, frameId });
	for (const [index, sheet] of snapshot.stylesheets.entries())
		if (sheet.css)
			telemetry.text(`${phase}/style-${index}.css`, sheet.css, "text/css", { href: sheet.href, sanitized: true });
	for (const [index, script] of snapshot.scripts.entries())
		if (script.inline)
			telemetry.text(`${phase}/inline-${index}.js`, script.inline, "text/javascript", { sanitized: true });
	for (const [index, canvas] of snapshot.canvases.entries()) {
		if (canvas.data && canvas.data.length < 2_500_000) {
			const blob = await (await fetch(canvas.data)).blob();
			telemetry.asset(`${phase}/canvas-${index}.png`, blob, { width: canvas.width, height: canvas.height });
		} else if ("error" in canvas) telemetry.warn(String(canvas.error));
		else if (canvas.data) telemetry.warn(`Canvas omitted at snapshot size limit: ${phase}/canvas-${index}.png`);
	}
	// Public script sources are collected once, after interaction has finished.
	if (phase === "after") {
		const allSources = [
			...new Set(
				snapshot.scripts.filter((script) => script.src && !script.queryOmitted).map((script) => script.src!),
			),
		];
		const sources = allSources.slice(0, 3);
		if (allSources.length > sources.length)
			telemetry.warn(`Script source limit omitted ${allSources.length - sources.length} source(s)`);
		const queryOmitted = snapshot.scripts.filter((script) => script.src && script.queryOmitted).length;
		if (queryOmitted) telemetry.warn(`Script source URLs with queries omitted: ${queryOmitted}`);
		await Promise.all(
			sources.map(async (src) => {
				const url = new URL(src);
				if (!/^https?:$/.test(url.protocol) || url.origin !== new URL(snapshot.url).origin) {
					telemetry.warn(`Cross-origin or unsupported script source omitted: ${telemetryUrl(src)}`);
					return;
				}
				try {
					const response = await fetch(url, {
						credentials: "omit",
						redirect: "error",
						referrerPolicy: "no-referrer",
						cache: "force-cache",
						signal: AbortSignal.timeout(3000),
					});
					if (
						!response.ok ||
						Number(response.headers.get("content-length")) > 1_000_000 ||
						!/javascript|ecmascript|text\/plain/i.test(response.headers.get("content-type") ?? "")
					) {
						telemetry.warn(`Script source unavailable: ${telemetryUrl(src)}`);
						return;
					}
					const reader = response.body?.getReader();
					if (!reader) {
						telemetry.warn(`Script response body unavailable: ${telemetryUrl(src)}`);
						return;
					}
					const chunks: Uint8Array[] = [];
					let size = 0;
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						size += value.length;
						if (size > 1_000_000) {
							await reader.cancel();
							telemetry.warn(`Script source too large: ${telemetryUrl(src)}`);
							return;
						}
						chunks.push(value);
					}
					const source = await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).text();
					telemetry.text("script-source.js", source, "text/javascript", {
						src: telemetryUrl(src),
						sanitized: true,
					});
				} catch {
					telemetry.warn(`Script source capture failed: ${telemetryUrl(src)}`);
				}
			}),
		);
	}
	telemetry.checkpoint();
}
