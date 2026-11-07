import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

// Run explicitly with node --env-file=.env scripts/benchmark-verification.mjs.
// This sends reference and scene crops to Typesafe and incurs API usage.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = JSON.parse(await readFile(join(root, "docs/typesafe-verification-evidence.json"), "utf8"));
const imageDir = process.argv[2] || "/Users/zeus/Library/Caches/Clop/images";
const output = process.argv[3] || "/tmp/sitegeist-typesafe-benchmark.json";
const requestedId = process.argv[4];
const fixtures = [...evidence.results, ...(evidence.regressions || [])].filter(
	(fixture) => !requestedId || fixture.id === requestedId,
);
if (!fixtures.length) throw new Error("No matching benchmark input");
if (!process.env.TYPESAFE_API_KEY) throw new Error("Set TYPESAFE_API_KEY in the local environment");
const baseUrl = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai";
const model = process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest";
const bundle = await build({
	entryPoints: [join(root, "src/tools/verification/typesafe-recognition.ts")],
	bundle: true,
	format: "iife",
	globalName: "Jev",
	write: false,
});
const browser = await chromium.launch();
const results = [];
try {
	const page = await browser.newPage();
	await page.route("http://localhost:9800/", (route) =>
		route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
	);
	await page.goto("http://localhost:9800/");
	await page.addScriptTag({ content: bundle.outputFiles[0].text });
	await page.route(`${new URL(baseUrl).origin}/**`, async (route) => {
		try {
			// The isolated page receives a dummy credential; only this Node bridge has the key.
			const response = await route.fetch({
				timeout: 10_000,
				headers: { ...route.request().headers(), authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
			});
			await route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
		} catch {
			await route.abort();
		}
	});
	for (const fixture of fixtures) {
		const input = await readFile(join(imageDir, fixture.input.file));
		if (createHash("sha256").update(input).digest("hex") !== fixture.input.sha256)
			throw new Error(`Image ${fixture.input.file} has changed; do not reuse its old geometry`);
		const result = await page.evaluate(
			async ({ fixture, input, baseUrl, model }) => {
				const image = new Image();
				image.src = `data:image/png;base64,${input}`;
				await image.decode();
				const canvas = new OffscreenCanvas(image.width, image.height);
				canvas.getContext("2d").drawImage(image, 0, 0);
				const [rx, ry, rw, rh] = fixture.input.reference;
				const references = fixture.input.targets.map((_, i, targets) => ({
					x: rx + Math.round((rw * i) / targets.length),
					y: ry,
					width: Math.round((rw * (i + 1)) / targets.length) - Math.round((rw * i) / targets.length),
					height: rh,
				}));
				const [x, y, width, height] = fixture.input.scene;
				const start = performance.now();
				try {
					const response = await Jev.recognizeWithJev(
						canvas,
						references,
						{ x, y, width, height },
						{ apiKey: "benchmark-bridge", baseUrl, model },
						start + 10_000,
					);
					return {
						id: fixture.id,
						ms: Math.round(performance.now() - start),
						...response,
						correct: response.rankings.map((ranks, i) => {
							const box = ranks[response.matches[i]?.selected ?? 0]?.box;
							const [tx, ty] = fixture.input.targets[i];
							return Boolean(
								box && tx >= box.x && tx < box.x + box.width && ty >= box.y && ty < box.y + box.height,
							);
						}),
					};
				} catch (error) {
					return { id: fixture.id, ms: Math.round(performance.now() - start), error: error.message };
				}
			},
			{ fixture, input: input.toString("base64"), baseUrl, model },
		);
		results.push(result);
		await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
		console.log(
			JSON.stringify({
				id: result.id,
				ms: result.ms,
				correct: result.correct,
				accepted: result.matches?.map((match) => match.accepted),
				error: result.error,
			}),
		);
	}
} finally {
	await browser.close();
}
