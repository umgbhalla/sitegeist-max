import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Importable, credential-free Chrome extension SDK with declarations. */
export async function buildVerificationSdk(outDir = join(root, "dist-verification-sdk")) {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const result = await build({
		absWorkingDir: root,
		entryPoints: ["src/verification-sdk/index.ts"],
		outfile: join(outDir, "index.js"),
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "chrome120",
		sourcemap: true,
		metafile: true,
	});
	if (Object.keys(result.metafile.inputs).some((path) => !path.startsWith("src/verification-sdk/")))
		throw new Error("The verification SDK must not depend on application or third-party runtime code");
	execFileSync("tsc", ["--project", join(root, "src/verification-sdk/tsconfig.json"), "--outDir", outDir], {
		cwd: root,
		stdio: "pipe",
		env: {
			...process.env,
			PATH: [join(root, "node_modules/.bin"), join(root, "../mini-lit/node_modules/.bin"), process.env.PATH]
				.filter(Boolean)
				.join(delimiter),
		},
	});
	writeFileSync(
		join(outDir, "README.md"),
		readFileSync(join(root, "src/verification-sdk/README.md"), "utf8").replace(
			"../../docs/verification-telemetry.md",
			"telemetry.md",
		),
	);
	copyFileSync(join(root, "docs/verification-telemetry.md"), join(outDir, "telemetry.md"));
	writeFileSync(
		join(outDir, "package.json"),
		`${JSON.stringify(
			{
				name: "@sitegeist/verification-sdk",
				version: "0.1.0",
				private: true,
				type: "module",
				sideEffects: false,
				exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
			},
			null,
			2,
		)}\n`,
	);
	return outDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	buildVerificationSdk()
		.then((outDir) => console.log(`Built verification SDK: ${outDir}`))
		.catch((error) => {
			console.error(error instanceof Error ? error.message : "SDK build failed");
			process.exitCode = 1;
		});
}
