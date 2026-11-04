import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const lab = dirname(fileURLToPath(import.meta.url));
const vendor = join(lab, "vendor");
const stateDir = join(lab, "state");

const firstFile = (base: string) =>
	["", ".tsx", ".ts", "/index.tsx", "/index.ts"].map((ext) => base + ext).find((path) => existsSync(path));

/**
 * Fluid Functionalism imports its own files through `@/` rooted at its repo, so
 * `@/` from a file under vendor/ff resolves there. Next-only modules map to shims.
 */
function kitAliases(): Plugin {
	const shims: Record<string, string> = {
		"next/link": join(lab, "src/shims/next-link.tsx"),
		"next/image": join(lab, "src/shims/next-image.tsx"),
	};
	return {
		name: "lab-kit-aliases",
		enforce: "pre",
		resolveId(source, importer) {
			if (shims[source]) return shims[source];
			if (!source.startsWith("@/") || !importer) return null;
			const root = join(vendor, "ff");
			return importer.startsWith(root + sep) ? (firstFile(join(root, source.slice(2))) ?? null) : null;
		},
	};
}

/**
 * GET/POST /api/state/<name>: the tuned configuration for a view, written to
 * lab/state/<name>.json so it can be read back and applied to the extension.
 */
function stateApi(): Plugin {
	return {
		name: "lab-state-api",
		configureServer(server) {
			server.middlewares.use("/api/state", (req, res) => {
				mkdirSync(stateDir, { recursive: true });
				const name = decodeURIComponent((req.url ?? "/").slice(1)).replace(/[^a-z0-9._-]/gi, "_");
				res.setHeader("content-type", "application/json");
				if (!name) {
					res.end(JSON.stringify(readdirSync(stateDir).filter((file) => file.endsWith(".json"))));
					return;
				}
				const file = join(stateDir, `${name}.json`);
				if (req.method === "POST") {
					let body = "";
					req.on("data", (chunk) => {
						body += chunk;
					});
					req.on("end", () => {
						const value = JSON.parse(body);
						writeFileSync(file, `${JSON.stringify({ savedAt: new Date().toISOString(), ...value }, null, "\t")}\n`);
						res.end(JSON.stringify({ ok: true, file: `lab/state/${name}.json` }));
					});
					return;
				}
				res.end(existsSync(file) ? readFileSync(file, "utf8") : "null");
			});
		},
	};
}

export default defineConfig({
	plugins: [kitAliases(), react(), tailwindcss(), stateApi()],
	publicDir: join(vendor, "public"),
	build: { rollupOptions: { input: { shell: resolve(lab, "index.html"), frame: resolve(lab, "frame.html") } } },
});
