/**
 * SINGLE source of truth for the entire `browser.*` surface.
 *
 * Exports a typed DOCS array (one entry per member) plus pure render functions
 * that turn DOCS into (a) the dense per-namespace prompt block and (b) runtime
 * help()/docs() text. Prompt and help() can never diverge because they read the
 * same array.
 *
 * ZERO chrome/DOM imports here — this file is importable from both the
 * privileged provider AND bundled (stringified) into the in-sandbox runtime stub.
 */

export type DocEntry = {
	ns: string;
	name: string; // dotted member path relative to `browser`, e.g. "input.click"
	signature: string;
	summary: string;
	example: string;
	/**
	 * 'stub' marks a member whose privileged handler is not yet wired and always
	 * throws a typed *_UNWIRED error. Renderers prefix these so the prompt/help do
	 * not advertise them as working. Omit for live members.
	 */
	status?: "stub";
};

export const NS_ORDER = ["chrome", "cdp", "input", "read", "groups", "ai", "fork", "net", "activeTab", "tabs", "meta"];

/** Prefix shown before unwired (stub) members in every rendered surface. */
const STUB_TAG = "[NOT YET WIRED — throws *_UNWIRED]";

export const DOCS: DocEntry[] = [
	// ── chrome ───────────────────────────────────────────────────────────────
	{
		ns: "chrome",
		name: "chrome",
		signature: "browser.chrome: <allowlisted read-only chrome.*>",
		summary:
			"ALLOWLISTED read-only window into chrome.*. Forwards only safe getters (tabs.query/get, tabGroups.query/get, windows.get*, runtime.getManifest, storage.local/session.get). chrome.debugger.* is hard-blocked (use browser.cdp), and tab/window/group mutation, downloads and scripting throw CHROME_BLOCKED — use browser.groups.* / browser.cdp / browser.read for those. Only JSON-serializable results cross the bridge.",
		example: "const win = await browser.chrome.windows.getCurrent(); console.log(win.id)",
	},
	// ── cdp ──────────────────────────────────────────────────────────────────
	{
		ns: "cdp",
		name: "cdp",
		signature: "browser.cdp(domain: string, method: string, params?: object): Promise<any>",
		summary:
			"Raw escape hatch into the Chrome DevTools Protocol on the active tab. Auto-attaches, re-attaches after service-worker teardown, keeps the session alive, and throws typed {code,hint} errors. Destructive methods are gated behind a human-confirm dialog. NOTE: Chrome shows an unsuppressable 'Sitegeist is debugging this browser' infobar once this fires.",
		example: "await browser.cdp('DOMSnapshot','captureSnapshot',{computedStyles:[]})",
	},
	// ── input ────────────────────────────────────────────────────────────────
	{
		ns: "input",
		name: "input.click",
		signature: "browser.input.click(selector: string): Promise<void>",
		summary: "Dispatch a TRUSTED (isTrusted:true) mouse click at the center of the first matching element via CDP Input.dispatchMouseEvent. Defeats anti-bot checks that synthetic clicks fail.",
		example: "await browser.input.click('button[type=submit]')",
	},
	{
		ns: "input",
		name: "input.type",
		signature: "browser.input.type(selector: string, text: string): Promise<void>",
		summary: "Focus the matching element then type `text` as trusted per-character key events via CDP Input.dispatchKeyEvent.",
		example: "await browser.input.type('input[name=email]', 'me@example.com')",
	},
	{
		ns: "input",
		name: "input.press",
		signature: "browser.input.press(key: string): Promise<void>",
		summary: "Press and release a single key (keyDown+keyUp). Accepts names like 'Enter', 'Tab', 'ArrowDown', 'Escape', or any single character.",
		example: "await browser.input.press('Enter')",
	},
	{
		ns: "input",
		name: "input.keyDown",
		signature: "browser.input.keyDown(key: string): Promise<void>",
		summary: "Press a key WITHOUT releasing it. Use for held modifiers (Shift/Control/Meta/Alt) before another input call; the modifier state is tracked until keyUp.",
		example: "await browser.input.keyDown('Shift'); await browser.input.press('Tab'); await browser.input.keyUp('Shift')",
	},
	{
		ns: "input",
		name: "input.keyUp",
		signature: "browser.input.keyUp(key: string): Promise<void>",
		summary: "Release a previously held key, clearing its modifier state.",
		example: "await browser.input.keyUp('Control')",
	},
	// ── read ─────────────────────────────────────────────────────────────────
	{
		ns: "read",
		name: "read",
		signature: "browser.read(opts?: { format?: 'snapshot'|'ax' }): Promise<any>",
		summary:
			"Read the active page. 'snapshot' (default) = CDP DOMSnapshot.captureSnapshot (full DOM, pierces frames+shadow); 'ax' = CDP Accessibility.getFullAXTree (semantic tree). Both are read-only and run without a confirm dialog. Prefer this over hand-rolled DOM scraping. (No 'readability' format — the privileged-side CSP forbids the remote parser import.)",
		example: "await browser.read({format:'ax'})  // Accessibility.getFullAXTree",
	},
	// ── groups ───────────────────────────────────────────────────────────────
	{
		ns: "groups",
		name: "groups.create",
		signature: "browser.groups.create(tabIds: number[], opts?: { title?: string; color?: string }): Promise<number>",
		summary: "Group the given tabs (chrome.tabs.group, no extra permission) and optionally set title/color (chrome.tabGroups.update). Returns the new groupId.",
		example:
			"const g = await browser.groups.create(await browser.tabs().then(t=>t.filter(x=>x.url.includes('github')).map(x=>x.tabId)), {title:'GH', color:'blue'})",
	},
	{
		ns: "groups",
		name: "groups.update",
		signature: "browser.groups.update(groupId: number, props: object): Promise<void>",
		summary: "Update a tab group's properties (title, color, collapsed) via chrome.tabGroups.update.",
		example: "await browser.groups.update(g, { title: 'Done', color: 'green' })",
	},
	{
		ns: "groups",
		name: "groups.query",
		signature: "browser.groups.query(filter?: object): Promise<any[]>",
		summary: "List tab groups matching the filter via chrome.tabGroups.query (e.g. {collapsed:false}). No filter returns all groups.",
		example: "const groups = await browser.groups.query({ collapsed: false })",
	},
	{
		ns: "groups",
		name: "groups.move",
		signature: "browser.groups.move(groupId: number, props: object): Promise<void>",
		summary: "Move a tab group to a new index/window via chrome.tabGroups.move.",
		example: "await browser.groups.move(g, { index: 0 })",
	},
	{
		ns: "groups",
		name: "groups.collapse",
		signature: "browser.groups.collapse(groupId: number, collapsed?: boolean): Promise<void>",
		summary: "Collapse (default) or expand a tab group via chrome.tabGroups.update({collapsed}).",
		example: "await browser.groups.collapse(g)        // collapse\nawait browser.groups.collapse(g, false) // expand",
	},
	{
		ns: "groups",
		name: "groups.ungroup",
		signature: "browser.groups.ungroup(tabIds: number[]): Promise<void>",
		summary: "Remove the given tabs from their group via chrome.tabs.ungroup.",
		example: "await browser.groups.ungroup(await browser.tabs().then(t=>t.map(x=>x.tabId)))",
	},
	// ── ai ───────────────────────────────────────────────────────────────────
	{
		ns: "ai",
		name: "ai",
		signature: "browser.ai(prompt: string, opts?: { system?: string; task?: 'prompt'|'summarize'|'detect' }): Promise<string>",
		summary:
			"On-device Chrome built-in AI. task:'prompt' (default) → self.LanguageModel; 'summarize' → self.Summarizer (summarizes the prompt text); 'detect' → self.LanguageDetector. Each is GATED on its own availability() — throws {code:'AI_UNAVAILABLE'} when the on-device model is absent (needs desktop, >4GB VRAM, ~22GB disk). Summarizer/LanguageDetector are best-effort/less-stable than LanguageModel. Translate is NOT exposed here (needs source/target langs — use self.Translator.create directly); Writer/Rewriter/Proofreader are NOT used (unstable).",
		example: "if ((await self.LanguageModel.availability()) !== 'unavailable') return await browser.ai('Explain CDP in one sentence')",
	},
	// ── fork ─────────────────────────────────────────────────────────────────
	{
		ns: "fork",
		name: "fork",
		status: "stub",
		signature: "browser.fork<T>(fn: () => T): Promise<{ resume(): Promise<T>; snapshot(): string }>",
		summary:
			"Checkpoint/branch a DETERMINISTIC, SYNCHRONOUS computation in a separate js-interpreter realm (hosted in an offscreen doc to survive SW teardown). snapshot() serializes the interpreter state stack; resume() restores it. ES5-ONLY, ~1000x slower, internal API unstable. Rejects fn source containing await/import. NOT for page or async code. NOT YET WIRED: throws FORK_UNWIRED until the offscreen js-interpreter host ships — use deterministic JS in the REPL directly for now.",
		example: "const f = await browser.fork(() => { let n=0; for(;n<3;n++); return n; }); const s = f.snapshot(); // currently throws FORK_UNWIRED",
	},
	// ── net ──────────────────────────────────────────────────────────────────
	{
		ns: "net",
		name: "net.intercept",
		status: "stub",
		signature: "browser.net.intercept(pattern: string|RegExp, handler: (req) => { fulfill?: object; continue?: object }): Promise<{ stop(): void }>",
		summary:
			"Intercept matching network requests on the active tab via CDP Fetch.enable. NOT YET WIRED: a JS handler cannot be structured-cloned across the sandbox bridge, so this throws NET_INTERCEPT_UNWIRED. Drive interception directly with browser.cdp('Fetch','enable',...) + browser.cdp('Fetch','fulfillRequest'|'continueRequest',...) instead.",
		example: "// NOT YET WIRED — use browser.cdp('Fetch','enable',{patterns:[{urlPattern:'*/api/*'}]}) then handle events via cdp directly",
	},
	// ── activeTab ────────────────────────────────────────────────────────────
	{
		ns: "activeTab",
		name: "activeTab",
		signature: "browser.activeTab(): Promise<{ tabId: number; url: string; title: string; favicon?: string }>",
		summary: "Pull live context for the current tab (chrome.tabs.query active+currentWindow). Call this whenever you need to know what page the user is on — page grounding is no longer pushed every turn.",
		example: "const { url, title } = await browser.activeTab()",
	},
	// ── tabs ─────────────────────────────────────────────────────────────────
	{
		ns: "tabs",
		name: "tabs",
		signature: "browser.tabs(): Promise<Array<{ tabId: number; url: string; title: string; active: boolean; groupId: number }>>",
		summary: "List all open tabs across windows (chrome.tabs.query({})). Use with browser.groups.* to organize, or to pick a tabId for cross-tab work.",
		example: "const tabs = await browser.tabs(); const gh = tabs.filter(t => t.url.includes('github.com'))",
	},
	// ── self-documenting (run fully in-sandbox, no round-trip) ────────────────
	{
		ns: "meta",
		name: "help",
		signature: "browser.help(ns?: string): string",
		summary: "Print this reference at runtime. No arg = index of namespaces + members; with a namespace (e.g. 'cdp') = that namespace's members. Same source as the system-prompt docs, so they never drift.",
		example: "browser.help()        // index\nbrowser.help('groups') // one namespace",
	},
	{
		ns: "meta",
		name: "docs",
		signature: "browser.docs(name: string): string",
		summary: "Print the full card (signature + summary + example) for a single member by dotted name. Throws {code:'UNKNOWN_DOC'} with a hint if the name is unknown.",
		example: "browser.docs('cdp')\nbrowser.docs('input.click')",
	},
];

/** Prefix a summary with the stub tag when the member is not yet wired. */
function summaryWithStatus(d: DocEntry): string {
	return d.status === "stub" ? `${STUB_TAG} ${d.summary}` : d.summary;
}

/**
 * Dense per-namespace markdown for the SYSTEM PROMPT.
 * Returned by BrowserRuntimeProvider.getDescription().
 */
export function renderPromptDocs(): string {
	const out: string[] = [];
	out.push("## browser (ambient global)");
	out.push(
		"A single `browser` object is available in the REPL with a deny-by-default CDP escape hatch (`browser.cdp`, gated) and an allowlisted read-only `browser.chrome` plus footgun wrappers. All errors throw as `{ code, hint }`. Members tagged " +
			STUB_TAG +
			" are not yet implemented and will throw. Call `browser.help()` / `browser.docs(name)` at runtime for the same reference.",
	);
	for (const ns of NS_ORDER) {
		const entries = DOCS.filter((d) => d.ns === ns);
		if (entries.length === 0) continue;
		out.push(`### browser.${ns}`);
		for (const d of entries) {
			out.push(`**browser.${d.name}** — ${summaryWithStatus(d)}`);
			out.push("`" + d.signature + "`");
			out.push("```js\n" + d.example + "\n```");
		}
	}
	return out.join("\n\n");
}

/**
 * SINGLE-SOURCE help()/docs() implementations.
 *
 * These run BOTH privileged-side (exported, imported wherever needed) AND
 * in-sandbox: BrowserRuntimeProvider.getData() ships their `.toString()` (plus
 * DOCS, NS_ORDER, STUB_TAG) into the iframe, where the runtime stub rebuilds them
 * with `new Function(...)`. There is NO second copy — do not reimplement this
 * logic inline anywhere. Keep them self-contained and dependency-free so they
 * survive stringification (only reference their own args + the injected DOCS /
 * NS_ORDER / STUB_TAG globals passed in).
 */
export function renderHelp(ns: string | undefined, docs: DocEntry[], nsOrder: string[], stubTag: string): string {
	if (!ns) {
		const lines: string[] = ["browser — ambient REPL global. Namespaces:"];
		for (const n of nsOrder) {
			const members = docs.filter((d) => d.ns === n).map((d) => `browser.${d.name}`);
			if (members.length) lines.push(`  ${n}: ${members.join(", ")}`);
		}
		lines.push("");
		lines.push("Use browser.help('<ns>') for a namespace, browser.docs('<name>') for one member.");
		return lines.join("\n");
	}
	const entries = docs.filter((d) => d.ns === ns);
	if (entries.length === 0) {
		return `Unknown namespace '${ns}'. Known: ${nsOrder.join(", ")}`;
	}
	const lines: string[] = [`browser.${ns}:`];
	for (const d of entries) {
		lines.push("");
		const tag = d.status === "stub" ? `${stubTag} ` : "";
		lines.push(`browser.${d.name} — ${tag}${d.summary}`);
		lines.push(`  ${d.signature}`);
		lines.push(`  e.g. ${d.example.replace(/\n/g, "\n       ")}`);
	}
	return lines.join("\n");
}

export function renderDoc(name: string, docs: DocEntry[], stubTag: string): string {
	const d = docs.find((e) => e.name === name);
	if (!d) {
		const known = docs.map((e) => e.name).join(", ");
		throw Object.assign(new Error(`Unknown doc '${name}'. Known members: ${known}`), {
			code: "UNKNOWN_DOC",
			hint: `Pass one of: ${known}`,
		});
	}
	const tag = d.status === "stub" ? `${stubTag}\n\n` : "";
	return [`browser.${d.name}`, "", `${tag}${d.summary}`, "", `Signature: ${d.signature}`, "", "Example:", d.example].join("\n");
}

/** Names of the injected globals + stringified renderers, for getData(). */
export function getDocsBundle(): {
	docs: DocEntry[];
	nsOrder: string[];
	stubTag: string;
	renderHelpSrc: string;
	renderDocSrc: string;
} {
	return {
		docs: DOCS,
		nsOrder: NS_ORDER,
		stubTag: STUB_TAG,
		renderHelpSrc: renderHelp.toString(),
		renderDocSrc: renderDoc.toString(),
	};
}
