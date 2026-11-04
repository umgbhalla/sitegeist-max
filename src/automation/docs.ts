import type { DocEntry } from "../tools/repl/browser/docs.js";

export const AUTOMATION_DOCS: DocEntry[] = [
	{
		ns: "page",
		name: "page.evaluate",
		signature:
			'browser.page.evaluate({tabId, origin?, expression, world?: "MAIN" | "ISOLATED", frameId?, contextId?}); browser.page.contexts({tabId})',
		summary:
			"Explicit-tab async page execution, MAIN by default. Unlike browserjs USER_SCRIPT, MAIN sees page-owned React metadata and request clients. Pass origin to reject changed-site targets. Returns serializable data; secret-named fields are redacted. Timeout 25s. contexts lists execution worlds and frame IDs. MAIN or ISOLATED can select frameId; contextId selects a known current context. Out-of-process frames may require a separate debugger target.",
		example: 'await browser.page.evaluate({tabId: 123, origin: "https://example.com", expression: "document.title"})',
	},
	{
		ns: "page",
		name: "page.request",
		signature: "browser.page.request({tabId, origin, url, method?, headers?, body?, adapter?, input?})",
		summary:
			"Run an authenticated same-origin request in MAIN with browser-managed cookies. If plain fetch fails, inspect the site's request client and supply adapter as an async function expression accepting config and returning Response or data. Credentials stay in the page; do not copy tokens into code, arguments, logs, or packets. A 401 is a failure, not an empty result. For large bodies use network capture.",
		example:
			'await browser.page.request({tabId: 123, origin: "https://example.com", url: "/api/orders", adapter: "async config => window.app.api.get(config.url)"})',
	},
	{
		ns: "page",
		name: "page.navigate",
		signature: "browser.page.navigate({tabId, url})",
		summary: "Navigate an explicit tab and wait for completion. Jobs must pin tab IDs; never rely on the active tab.",
		example: 'await browser.page.navigate({tabId: 123, url: "https://example.com/orders/1"})',
	},
	{
		ns: "net",
		name: "net.start",
		signature: "browser.net.start({tabId, pattern?, maxBodyBytes?, maxRecords?, download?: {packet, name}})",
		summary:
			"Start persistent CDP network recording BEFORE page actions. Wildcard URL pattern defaults to current origin. Captures request IDs, methods, JSON request shapes, response metadata and bodies. Auth headers and secret fields are redacted on read. download captures original attachment/PDF response bytes before releasing the response, including same-tab downloads. Scope pattern to invoice URL; one active capture per tab. Stop when finished. 16 MB/body and 1000 records default, bounded limits fail explicitly.",
		example:
			'const capture = await browser.net.start({tabId: 123, pattern: "https://example.com/api/*"}); console.log(capture.id)',
	},
	{
		ns: "net",
		name: "net.list",
		signature:
			"browser.net.list({id}); browser.net.status({id}); browser.net.body({id: responseId}); browser.net.save({id: responseId, packet, name}); browser.net.replay({id: responseId}); browser.net.stop({id})",
		summary:
			"List recorded response handles without loading bodies into chat. Read only needed bodies or save them directly into packets. status reports capture errors. Native replay uses a captured read-only XHR ID without exposing session credentials; fetch requests need page.request adapters. Missing/evicted bodies produce errors, never fake success.",
		example:
			'const records = await browser.net.list({id: capture.id}); console.log(records.filter(r => r.mime?.includes("json")));',
	},
	{
		ns: "files",
		name: "files.write",
		signature:
			'browser.files.write({packet, name, data, mime?, encoding?: "text" | "base64"}); browser.files.list({packet}); browser.files.read({packet,name})',
		summary:
			"Persist packet files in IndexedDB, including JSON, CSV, PDFs and images. Existing names are immutable unless content hashes match; use new names for revisions. Files survive panel/worker restarts. Each file stores SHA-256 and byte size. read returns base64; prefer references to large data.",
		example:
			'await browser.files.write({packet: "orders", name: "orders.json", data: JSON.stringify(orders), mime: "application/json"})',
	},
	{
		ns: "files",
		name: "files.export",
		signature:
			"browser.files.validate({packet, expected: string[]}); browser.files.export({packet, expected: string[]})",
		summary:
			"Validate every expected file and SHA-256. Export requires the complete explicit file list; unexpected/missing/corrupt entries fail. Creates manifest.json, ZIPs, reopens and verifies the ZIP, then saves it using Chrome downloads. Returns downloadId, archive hash, size. No overwrites. 250 MiB maximum packet per export.",
		example:
			'const names = (await browser.files.list({packet: "orders"})).map(f => f.name); await browser.files.export({packet: "orders", expected: names})',
	},
	{
		ns: "downloads",
		name: "downloads.save",
		signature:
			"browser.downloads.fetch({tabId,origin,url,packet,name,adapter?,input?}); browser.downloads.save({packet,name}); browser.downloads.status({id: downloadId})",
		summary:
			"Save original packet bytes to Downloads and track completion/interruption. To ingest a site's download, arm net.start with download:{packet,name} BEFORE clicking the page's real invoice/download control, then verify files.list. A download ID alone is not completion proof. downloads.fetch saves HTTP or blob URL bytes through the signed-in page (optional page-client adapter). Fetch blob-generated files before their originating page navigates.",
		example:
			'await browser.net.start({tabId: 123, pattern: "https://example.com/invoice/*", download: {packet: "orders", name: "order-1.pdf"}})',
	},
	{
		ns: "screenshot",
		name: "screenshot",
		signature:
			"browser.screenshot({tabId, packet, orderId, readySelector?, rowSelector?, expectedRows?, addressSelector?})",
		summary:
			"Scroll-load the actual page, wait for fonts/images, check expected row count and address clipping, then export full-page PNG plus evidence JSON named by orderId. Detects virtualized rows and fails instead of silently omitting them: expand all rows or use separate pages. Set expectedRows/addressSelector when evidence completeness matters. Bounded to 80M pixels/50K height.",
		example:
			'await browser.screenshot({tabId: 123, packet: "orders", orderId: "order-1", rowSelector: ".item", expectedRows: 5, addressSelector: ".address"})',
	},
	{
		ns: "tools",
		name: "tools.save",
		signature:
			"browser.tools.save({name, description, source}); browser.tools.list(); browser.tools.get({name}); browser.tools.run(name,args)",
		summary:
			"Build reusable tools from observed site behavior. source is an async function (args,browser,job) => {...}, stored by name and immutable SHA-256 version. No closure variables survive; put input in args and secrets in the signed-in page. tools.run executes in this sandbox. For durable work use jobs.start; do not reinvent a site-specific server or assume undocumented API signatures.",
		example:
			'await browser.tools.save({name: "read-title", description: "Read title in a pinned page", source: async (args, browser) => browser.page.evaluate({tabId: args.tabId, expression: "document.title"})}); await browser.tools.run("read-title", {tabId: 123})',
	},
	{
		ns: "jobs",
		name: "jobs.start",
		signature:
			"browser.jobs.start({tool, args}); browser.jobs.get({id}); browser.jobs.list(); browser.jobs.steps({id}); browser.jobs.cancel({id}); browser.jobs.resume({id})",
		summary:
			"Run a saved tool version in an offscreen sandbox, independent of the chat panel. Jobs run serially and persist progress, args and checkpoints. Script receives job.step(key, async () => result, {idempotent:false,retries:0}) and job.progress(value). Put each order/action inside a unique step. Completed steps reuse saved results after restart. Only explicitly idempotent steps may retry. Interrupted writes stop with uncertain outcome instead of repeating. Browser must be running; restart resumes from checkpoints. Files belong in packets, not checkpoint results. Cancel stops the sandbox; already-issued browser actions may finish.",
		example:
			'await browser.tools.save({name: "batch", description: "Capture pages", source: async (args, browser, job) => { for (const item of args.items) await job.step(item.id, async () => { await browser.page.navigate({tabId: args.tabId, url: item.url}); return browser.screenshot({tabId: args.tabId, packet: args.packet, orderId: item.id}); }, {idempotent: true, retries: 2}); }}); const run = await browser.jobs.start({tool: "batch", args: {tabId: 123, packet: "orders", items}}); console.log(run.id)',
	},
	{
		ns: "sheets",
		name: "sheets.connect",
		signature:
			"browser.sheets.identity(); browser.sheets.connect({clientId,expectedEmail}); browser.sheets.appendTabs({spreadsheetId,expectedEmail,tabs:[{title,rows}]})",
		summary:
			"Dedicated Google OAuth connection, independent of the selected browser account. Requires a configured Google OAuth client with the redirect URI returned by identity(). connect opens sign-in and returns pending; poll identity for completion. Tokens stay private. Verifies Google email/sub immediately before each append. Adds NEW tabs only, with literal cell values, in one atomic batch; existing title collisions fail. Does not change existing cells or sharing. Never infer Google identity from the browser profile or Gemini login. Expired access needs reconnect.",
		example:
			'console.log(await browser.sheets.identity()); await browser.sheets.appendTabs({spreadsheetId, expectedEmail, tabs: [{title: "Export 2026-11-04", rows}]})',
	},
];
