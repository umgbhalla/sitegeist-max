import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const localEnv = join(packageRoot, ".env");
if (existsSync(localEnv)) loadEnvFile(localEnv);
const isWatch = process.argv.includes("--watch");
const isE2EBuild = process.env.SITEGEIST_E2E === "1";
const typesafeEnabled = !isE2EBuild && Boolean(process.env.TYPESAFE_API_KEY);
const staticDir = join(packageRoot, "static");

// Chrome only
const targetBrowser = "chrome";
const outDir = join(packageRoot, isE2EBuild ? "dist-chrome-e2e" : "dist-chrome");

const entryPoints = {
	"automation-host": join(packageRoot, "src/automation/host.ts"),
	sidepanel: join(packageRoot, "src/sidepanel.ts"),
	debug: join(packageRoot, "src/debug.ts"),
	icons: join(packageRoot, "src/icons.ts"),
	background: join(packageRoot, "src/background.ts"),
};

// Tailwind CSS output. build.mjs OWNS this so the panel can never be served
// without app.css (the panel's only stylesheet — see static/sidepanel.html:8).
const cssInput = join(packageRoot, "src/app.css");
const cssOutput = join(outDir, "app.css");

const tailwindBin = join(packageRoot, "node_modules/.bin/tailwindcss");

// Resolve the tailwind CLI; prefer the local .bin, fall back to npx.
const tailwindCommand = existsSync(tailwindBin) ? tailwindBin : "npx";
const tailwindBaseArgs = existsSync(tailwindBin) ? [] : ["tailwindcss"];

const cssIsReady = () => existsSync(cssOutput) && statSync(cssOutput).size > 0;

// One-shot Tailwind build that resolves only after a non-empty app.css exists.
const buildCss = () =>
	new Promise((resolve, reject) => {
		const child = spawn(tailwindCommand, [...tailwindBaseArgs, "-i", cssInput, "-o", cssOutput, "--minify"], {
			cwd: packageRoot,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`tailwindcss exited with code ${code}`));
				return;
			}
			if (!cssIsReady()) {
				reject(new Error(`Tailwind ran but ${cssOutput} is missing or empty`));
				return;
			}
			resolve();
		});
	});

// Long-running Tailwind --watch process for dev. Returns once the FIRST
// non-empty app.css has been emitted, so the dev server never reloads the
// panel before its stylesheet exists.
const watchCss = () =>
	new Promise((resolve, reject) => {
		const child = spawn(tailwindCommand, [...tailwindBaseArgs, "-i", cssInput, "-o", cssOutput, "--watch"], {
			cwd: packageRoot,
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code !== 0 && code !== null) {
				reject(new Error(`tailwindcss --watch exited with code ${code}`));
			}
		});

		// Poll until the first non-empty app.css appears, then let the build proceed.
		const start = Date.now();
		const poll = setInterval(() => {
			if (cssIsReady()) {
				clearInterval(poll);
				resolve();
			} else if (Date.now() - start > 30000) {
				clearInterval(poll);
				reject(new Error("Timed out waiting for initial app.css from tailwindcss --watch"));
			}
		}, 100);
	});

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const buildOptions = {
	absWorkingDir: packageRoot,
	entryPoints,
	bundle: true,
	outdir: outDir,
	format: "esm",
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	entryNames: "[name]",
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		__TYPESAFE_ENABLED__: JSON.stringify(typesafeEnabled),
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		// e2e UI-test flag: "1" swaps the LLM for an in-process mock (src/testing/mock-llm.ts).
		// Defaults "0" so prod builds are untouched. Set via `npm run build:e2e`.
		"process.env.SITEGEIST_E2E": JSON.stringify(isE2EBuild ? "1" : "0"),
		global: "globalThis",
	},
	inject: [join(packageRoot, "scripts/process-shim.js")],
	// Force all mini-lit and lit imports to resolve to sitegeist's node_modules
	alias: {
		process: join(packageRoot, "scripts/process-shim.js"),
		// pi-web-ui was deleted upstream (frozen at 0.75.3) so it can't move to
		// pi 0.80.6. We vendor its source into src/vendor/web-ui and retarget its
		// pi-ai imports to /compat; this alias keeps the ~33 sitegeist import sites
		// (`from "@earendil-works/pi-web-ui"`) unchanged. See docs / memory.
		"@earendil-works/pi-web-ui": join(packageRoot, "src/vendor/web-ui/index.ts"),
		"@mariozechner/mini-lit": join(packageRoot, "node_modules/@mariozechner/mini-lit"),
		lit: join(packageRoot, "node_modules/lit"),
		"lit/decorators.js": join(packageRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(packageRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(packageRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Private build configuration stays outside source and source maps.
	// dist-chrome is ignored; never distribute this private artifact publicly.
	if (typesafeEnabled) {
		writeFileSync(
			join(outDir, "typesafe.local.json"),
			JSON.stringify({
				apiKey: process.env.TYPESAFE_API_KEY,
				baseUrl: process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",
				model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest",
			}),
			{ mode: 0o600 },
		);
	}
	// Use browser-specific manifest
	const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(packageRoot, relative);
		const destination = join(outDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(packageRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(packageRoot, "../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built for ${targetBrowser} in ${outDir}`);
};

const run = async () => {
	if (isWatch) {
		const ctx = await context(buildOptions);
		await ctx.watch();
		copyStatic();

		// Generate the initial app.css and keep Tailwind watching. Awaiting this
		// guarantees app.css exists & is non-empty before we announce readiness,
		// so the dev server's first reload always finds a stylesheet.
		await watchCss();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(packageRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		await build(buildOptions);
		copyStatic();
		// CSS is part of the build: hard-fail if Tailwind can't produce a
		// non-empty app.css so we never ship a CSS-less panel.
		await buildCss();
		if (!cssIsReady()) {
			throw new Error(`Build finished but ${cssOutput} is missing or empty`);
		}
		console.log(`CSS written to ${cssOutput}`);
	}
};

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
