import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(join(root, ".env"))) loadEnvFile(join(root, ".env"));

/** Separate package: no Sitegeist chat, agent, or shared distribution writes. */
export async function buildVerification(
	outDir = join(root, "dist-verification-chrome"),
	config = {
		apiKey: process.env.TYPESAFE_API_KEY,
		baseUrl: process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",
		model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest",
	},
) {
	if (!config.apiKey) throw new Error("Set TYPESAFE_API_KEY in the private .env before building");
	const base = new URL(config.baseUrl);
	if (
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.pathname !== "/" ||
		base.search ||
		base.hash
	)
		throw new Error("TYPESAFE_BASE_URL must be an HTTPS origin");
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const result = await build({
		absWorkingDir: root,
		entryPoints: {
			background: join(root, "src/verification-extension/background.ts"),
			content: join(root, "src/verification-extension/content.ts"),
		},
		outdir: outDir,
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "chrome120",
		sourcemap: true,
		metafile: true,
		define: { __TYPESAFE_ENABLED__: "true" },
	});
	if (Object.keys(result.metafile.inputs).some((path) => /node_modules\/|verification-tool\.ts/.test(path)))
		throw new Error("The standalone package must not include agent or third-party runtime dependencies");
	if (!("src/verification-sdk/index.ts" in result.metafile.inputs))
		throw new Error("The standalone package must use the shared verification SDK entry point");
	copyFileSync(join(root, "src/verification-extension/manifest.json"), join(outDir, "manifest.json"));
	writeFileSync(join(outDir, "typesafe.local.json"), JSON.stringify(config), { mode: 0o600 });
	const secret = config.apiKey;
	for (const name of ["background.js", "background.js.map", "content.js", "content.js.map", "manifest.json"])
		if (readFileSync(join(outDir, name), "utf8").includes(secret))
			throw new Error("Private key appeared outside local config");
	return outDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	buildVerification()
		.then((outDir) => console.log(`Built standalone extension: ${outDir}`))
		.catch((error) => {
			console.error(error instanceof Error ? error.message : "Build failed");
			process.exitCode = 1;
		});
}
