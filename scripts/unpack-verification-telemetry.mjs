import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [input, destination] = process.argv.slice(2);
if (!input || !destination)
	throw new Error("Usage: node scripts/unpack-verification-telemetry.mjs export.json output-directory");
const dataset = JSON.parse(await readFile(input, "utf8"));
if (
	dataset.schema !== "sitegeist.verification.telemetry/1" ||
	!Array.isArray(dataset.runs) ||
	!Array.isArray(dataset.assets)
)
	throw new Error("Use an Export runs dataset containing images, not the older attempt-only JSON log");
const assets = new Map();
for (const asset of dataset.assets) {
	if (!/^[a-f0-9]{64}$/.test(asset.sha256) || asset.encoding !== "base64" || typeof asset.data !== "string")
		throw new Error("Invalid telemetry asset");
	const bytes = Buffer.from(asset.data, "base64");
	if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
		throw new Error(`Asset integrity failure: ${asset.sha256}`);
	const suffix = asset.mime === "image/png" ? ".png" : ".txt";
	assets.set(asset.sha256, { bytes, path: `assets/${asset.sha256}${suffix}`, mime: asset.mime });
}
const runIds = new Set();
for (const run of dataset.runs) {
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(run.id) || runIds.has(run.id) || !Array.isArray(run.assets))
		throw new Error("Invalid or duplicate run ID");
	runIds.add(run.id);
	for (const asset of run.assets) if (!assets.has(asset.sha256)) throw new Error(`Missing asset for run ${run.id}`);
}
const output = resolve(destination);
await mkdir(join(output, "assets"), { recursive: true });
await mkdir(join(output, "runs"), { recursive: true });
for (const asset of assets.values()) await writeFile(join(output, asset.path), asset.bytes, { flag: "wx" });
for (const run of dataset.runs)
	await writeFile(
		join(output, "runs", `${run.id}.json`),
		JSON.stringify(
			{
				...run,
				assets: run.assets.map((asset) => ({ ...asset, path: assets.get(asset.sha256).path })),
			},
			null,
			2,
		),
		{ flag: "wx" },
	);
await writeFile(
	join(output, "index.json"),
	JSON.stringify(
		{
			schema: dataset.schema,
			exportedAt: dataset.exportedAt,
			runs: dataset.runs.map((run) => ({
				id: run.id,
				status: run.status,
				label: run.label,
				path: `runs/${run.id}.json`,
				assets: run.assets.length,
			})),
		},
		null,
		2,
	),
	{ flag: "wx" },
);
console.log(JSON.stringify({ output, runs: dataset.runs.length, assets: assets.size, verified: true }));
