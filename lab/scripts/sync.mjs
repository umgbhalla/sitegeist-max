#!/usr/bin/env node
// Pull Fluid Functionalism at a pinned commit and copy its source into
// lab/vendor/ verbatim. Nothing under vendor/ is edited by hand: rerun this to
// update, bump a SHA to move. Integration lives outside vendor/ (vite.config.ts
// resolver, src/shims).
//
//   node scripts/sync.mjs            fetch pinned SHAs and copy
//   node scripts/sync.mjs --latest   move to the default branch HEAD

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const lab = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamDir = join(lab, ".upstream");
const vendorDir = join(lab, "vendor");
const latest = process.argv.includes("--latest");

const KITS = [
	{
		id: "ff",
		name: "Fluid Functionalism",
		repo: "https://github.com/mickadesign/fluid-functionalism.git",
		site: "https://www.fluidfunctionalism.com",
		sha: "168d8d4982654f72da8f76df169eafb20e825409",
		// The registry plus the site modules its homepage gallery (app/components/
		// bento-previews.tsx `previewMap`) imports, with the site's `@/` = repo root.
		paths: ["app/components", "app/globals.css", "components", "hooks", "lib", "registry", "types", "LICENSE", "motion-guidelines.md"],
		publicFiles: ["fonts", "micka.png", "favicon.svg", "design-notes.pdf", "Receipt-2581-4039-8265.pdf"],
	},
];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function checkout(kit) {
	const dir = join(upstreamDir, kit.id);
	if (!existsSync(join(dir, ".git"))) {
		mkdirSync(dir, { recursive: true });
		git(dir, "init", "-q");
		git(dir, "remote", "add", "origin", kit.repo);
	}
	if (latest) {
		git(dir, "fetch", "-q", "--depth", "1", "origin", "HEAD");
	} else {
		git(dir, "fetch", "-q", "--depth", "1", "origin", kit.sha);
	}
	git(dir, "checkout", "-q", "--force", "FETCH_HEAD");
	return { dir, sha: git(dir, "rev-parse", "HEAD"), date: git(dir, "log", "-1", "--format=%cI") };
}

rmSync(join(vendorDir, "public"), { recursive: true, force: true });
const provenance = { syncedAt: new Date().toISOString(), kits: {} };
for (const kit of KITS) {
	const { dir, sha, date } = checkout(kit);
	const target = join(vendorDir, kit.id);
	rmSync(target, { recursive: true, force: true });
	for (const path of kit.paths) {
		cpSync(join(dir, path), join(target, path), { recursive: true });
	}
	// The site serves assets from `/`; the lab serves vendor/public as Vite's public dir.
	for (const file of kit.publicFiles) {
		cpSync(join(dir, "public", file), join(vendorDir, "public", file), { recursive: true });
	}
	provenance.kits[kit.id] = { name: kit.name, repo: kit.repo, site: kit.site, sha, commitDate: date, paths: kit.paths };
	if (sha !== kit.sha) console.log(`${kit.id}: moved ${kit.sha.slice(0, 7)} -> ${sha.slice(0, 7)}; pin it in KITS`);
	console.log(`${kit.id}: ${kit.name} @ ${sha.slice(0, 7)} (${date})`);
}
writeFileSync(join(vendorDir, "PROVENANCE.json"), `${JSON.stringify(provenance, null, "\t")}\n`);
console.log("vendor/ written");
