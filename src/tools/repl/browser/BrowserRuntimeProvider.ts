/**
 * BrowserRuntimeProvider
 *
 * The ONE new SandboxRuntimeProvider for the `browser.*` surface.
 *
 *  - getData():     injects DOCS so browser.help()/docs() render in-sandbox.
 *  - getRuntime():  injects the single ambient `browser` global as a self-contained
 *                   stringified fn whose privileged members funnel to
 *                   sendRuntimeMessage({type:'browser', op, args}).
 *  - handleMessage(): privileged dispatcher — one switch over op that calls into
 *                   cdp-helpers / capability modules.
 *  - getDescription(): returns renderPromptDocs() so the dense docs land in the
 *                   system prompt every turn.
 *
 * SECURITY MODEL — browser.chrome is NOT an open reflection. It forwards ONLY an
 * explicit allowlist of safe, read-only chrome.* members (CHROME_ALLOW below).
 * chrome.debugger.* is hard-blocked (the ONLY sanctioned debugger path is
 * browser.cdp(), which is deny-by-default gated). Tab/window mutation
 * (tabs.remove/update/create, windows.remove), downloads, scripting and any
 * other re-entry into privileged side effects are NOT forwarded — they throw
 * CHROME_BLOCKED. This keeps page-controllable prompt content from reaching an
 * ungated destructive capability.
 *
 * Typed errors cross the bridge as an envelope {ok:false, error:{code,hint,message}}
 * which the stub re-throws as Object.assign(new Error(hint), error).
 */

import type { SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";
import { CdpError, attachActiveTab, cdp } from "./cdp-helpers.js";
import { getDocsBundle, renderPromptDocs } from "./docs.js";

/**
 * Allowlist of safe, read-only chrome.* members that browser.chrome may forward.
 * Each entry is a dotted path to a CALLABLE chrome API that has no destructive
 * side effects and returns a JSON-serializable value. Anything not listed throws
 * CHROME_BLOCKED. Mutating tab/window/group ops are exposed through the dedicated
 * browser.groups.* wrappers (privileged-side), not through this raw reflection.
 */
const CHROME_ALLOW: ReadonlySet<string> = new Set<string>([
	"tabs.query",
	"tabs.get",
	"tabGroups.query",
	"tabGroups.get",
	"windows.get",
	"windows.getCurrent",
	"windows.getAll",
	"windows.getLastFocused",
	"runtime.getManifest",
	"storage.local.get",
	"storage.session.get",
]);

type Envelope = { ok: true; value: unknown } | { ok: false; error: { code: string; hint: string; message: string } };

function ok(value: unknown): Envelope {
	return { ok: true, value };
}
function fail(e: unknown): Envelope {
	if (e instanceof CdpError) {
		return { ok: false, error: { code: e.code, hint: e.hint, message: e.message } };
	}
	const err = e as any;
	return {
		ok: false,
		error: {
			code: err?.code || "BROWSER_ERROR",
			hint: err?.hint || "See message for details.",
			message: err?.message || String(e),
		},
	};
}

export class BrowserRuntimeProvider implements SandboxRuntimeProvider {
	/** Lazily-created singleton offscreen document flag for browser.fork. */
	private offscreenReady = false;

	getData(): Record<string, any> {
		// Ship DOCS + the SINGLE-SOURCE renderHelp/renderDoc (as strings) so the
		// in-sandbox help()/docs() call the exact same code as the prompt path —
		// no divergent reimplementation. See docs.ts:getDocsBundle.
		return { __browserDocs: getDocsBundle() };
	}

	getRuntime(): (sandboxId: string) => void {
		// Stringified + injected into the REPL iframe. Cannot reference outer scope.
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			// Unwrap the privileged envelope: throw typed errors, return values.
			const call = async (op: string, args: any): Promise<any> => {
				const response = await sendRuntimeMessage({ type: "browser", op, args });
				const env = response.result;
				if (!env || env.ok) {
					return env ? env.value : undefined;
				}
				throw Object.assign(new Error(env.error.hint || env.error.message), env.error);
			};

			// browser.input.* forwards to the existing NativeInputEventsRuntimeProvider
			// (it already owns trusted CDP input) using its own message shape.
			const nativeInput = async (action: string, rest: any): Promise<void> => {
				await sendRuntimeMessage({ type: "native-input", action, ...rest });
			};

			// ── self-documenting (in-sandbox; SAME renderers as the prompt) ──
			// getData() injected window.__browserDocs = { docs, nsOrder, stubTag, renderHelpSrc, renderDocSrc }.
			// renderHelpSrc/renderDocSrc are the .toString() of the single-source
			// renderHelp/renderDoc in docs.ts — rebuilt here so there is ZERO
			// divergent reimplementation. (Reconstructing a function from its source
			// string runs inside the already-sandboxed REPL iframe.)
			const bundle: any = (window as any).__browserDocs || {};
			const DOCS_LOCAL: any[] = bundle.docs || [];
			const NS_ORDER: string[] = bundle.nsOrder || [];
			const STUB_TAG: string = bundle.stubTag || "";
			// eslint-disable-next-line no-new-func
			const reconstruct = (src: string): Function => {
				// `function name(args){...}` -> evaluate to the function value.
				return new Function(`return (${src})`)();
			};
			const renderHelpFn = reconstruct(bundle.renderHelpSrc);
			const renderDocFn = reconstruct(bundle.renderDocSrc);

			const help = (ns?: string): string => renderHelpFn(ns, DOCS_LOCAL, NS_ORDER, STUB_TAG);
			const docs = (name: string): string => renderDocFn(name, DOCS_LOCAL, STUB_TAG);

			// ── browser.chrome — Proxy that forwards property access/calls ──
			const makeChromeProxy = (path: string[]): any =>
				new Proxy(function () {}, {
					get(_t, prop: string) {
						if (prop === "then") return undefined; // not a thenable
						return makeChromeProxy([...path, prop]);
					},
					apply(_t, _this, args: any[]) {
						return call("chrome", { path, args });
					},
				});

			const browser: any = {
				chrome: makeChromeProxy([]),
				cdp: (domain: string, method: string, params?: object) => call("cdp", { domain, method, params }),
				input: {
					click: (selector: string) => nativeInput("click", { selector }),
					type: (selector: string, text: string) => nativeInput("type", { selector, text }),
					press: (key: string) => nativeInput("press", { key }),
					keyDown: (key: string) => nativeInput("keyDown", { key }),
					keyUp: (key: string) => nativeInput("keyUp", { key }),
				},
				read: (opts?: { format?: string }) => call("read", { opts: opts || {} }),
				groups: {
					create: (tabIds: number[], opts?: object) => call("groups.create", { tabIds, opts: opts || {} }),
					update: (groupId: number, props: object) => call("groups.update", { groupId, props }),
					query: (filter?: object) => call("groups.query", { filter: filter || {} }),
					move: (groupId: number, props: object) => call("groups.move", { groupId, props }),
					collapse: (groupId: number, collapsed?: boolean) =>
						call("groups.collapse", { groupId, collapsed: collapsed !== false }),
					ungroup: (tabIds: number[]) => call("groups.ungroup", { tabIds }),
				},
				ai: (prompt: string, opts?: object) => call("ai", { prompt, opts: opts || {} }),
				fork: async (fn: () => any) => {
					const src = fn.toString();
					const meta = await call("fork", { src });
					return {
						snapshot: () => meta.snapshot,
						resume: () => call("fork.resume", { stack: meta.snapshot }),
					};
				},
				net: {
					intercept: async (_pattern: string | RegExp, _handler: any) => {
						// Handlers cannot cross the bridge; net.intercept is privileged-side only.
						throw Object.assign(new Error("browser.net.intercept handler must run privileged-side"), {
							code: "NET_INTERCEPT_UNWIRED",
							hint: "net.intercept with a JS handler is not yet wired across the sandbox bridge; use browser.cdp('Fetch','enable',...) directly.",
						});
					},
				},
				activeTab: () => call("activeTab", {}),
				tabs: () => call("tabs", {}),
				help,
				docs,
			};

			(window as any).browser = browser;
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "browser") {
			return;
		}

		const op: string = message.op;
		const args = message.args || {};

		try {
			const value = await this.dispatch(op, args);
			respond({ success: true, result: ok(value) });
		} catch (e) {
			// Always resolve the bridge (success:true) and carry the typed error in
			// the envelope so {code,hint} survive the crossing.
			respond({ success: true, result: fail(e) });
		}
	}

	private async dispatch(op: string, args: any): Promise<unknown> {
		switch (op) {
			// ── raw escape hatches ──────────────────────────────────────────────
			case "chrome":
				return this.reflectChrome(args.path as string[], args.args as any[]);
			case "cdp":
				return cdp(args.domain, args.method, args.params);

			// ── read ────────────────────────────────────────────────────────────
			case "read":
				return this.read(args.opts || {});

			// ── tab context (pull) ──────────────────────────────────────────────
			case "activeTab":
				return this.activeTab();
			case "tabs":
				return this.tabs();

			// ── groups ──────────────────────────────────────────────────────────
			case "groups.create":
				return this.groupsCreate(args.tabIds, args.opts || {});
			case "groups.update":
				await chrome.tabGroups.update(args.groupId, args.props);
				return undefined;
			case "groups.query":
				return chrome.tabGroups.query(args.filter || {});
			case "groups.move":
				await chrome.tabGroups.move(args.groupId, args.props);
				return undefined;
			case "groups.collapse":
				await chrome.tabGroups.update(args.groupId, { collapsed: args.collapsed !== false });
				return undefined;
			case "groups.ungroup":
				await chrome.tabs.ungroup(args.tabIds);
				return undefined;

			// ── built-in AI ─────────────────────────────────────────────────────
			case "ai":
				return this.ai(args.prompt, args.opts || {});

			// ── fork (js-interpreter in offscreen doc) ──────────────────────────
			case "fork":
				return this.fork(args.src);
			case "fork.resume":
				return this.forkResume(args.stack);

			default:
				throw new CdpError("UNKNOWN_OP", `Unknown browser op: ${op}`, "This browser.* member is not implemented privileged-side.");
		}
	}

	// ── chrome.* reflection (allowlist-gated, read-only) ────────────────────────
	private async reflectChrome(path: string[], args: any[]): Promise<unknown> {
		const dotted = path.join(".");

		// Hard block: the debugger surface is reachable ONLY via browser.cdp(),
		// which is deny-by-default gated. Forwarding chrome.debugger.* here would
		// bypass the entire human-confirm gate.
		if (path[0] === "debugger") {
			throw new CdpError(
				"CHROME_BLOCKED",
				`chrome.debugger.* is not forwarded (attempted chrome.${dotted})`,
				"Use browser.cdp(domain, method, params) — the only sanctioned, human-gated debugger path.",
			);
		}

		// Deny-by-default: only the explicit safe read-only allowlist passes.
		if (!CHROME_ALLOW.has(dotted)) {
			throw new CdpError(
				"CHROME_BLOCKED",
				`chrome.${dotted} is not allowlisted`,
				`browser.chrome forwards only read-only APIs: ${[...CHROME_ALLOW].join(", ")}. For tab/group changes use browser.groups.*; for the page use browser.cdp / browser.read.`,
			);
		}

		let target: any = chrome;
		for (let i = 0; i < path.length - 1; i++) {
			target = target?.[path[i]];
			if (target == null) {
				throw new CdpError("CHROME_PATH", `chrome.${dotted} is undefined`, "Check the chrome.* path; this API may not exist.");
			}
		}
		const last = path[path.length - 1];
		const fn = path.length ? target?.[last] : target;
		if (typeof fn !== "function") {
			throw new CdpError(
				"CHROME_NOT_CALLABLE",
				`chrome.${dotted} is not a function`,
				"Only callable chrome.* members are forwarded; read properties via a wrapper API.",
			);
		}
		const result = await Promise.resolve(fn.apply(target, args));
		// Only JSON-serializable values cross the bridge.
		try {
			return JSON.parse(JSON.stringify(result ?? null));
		} catch {
			throw new CdpError(
				"NON_SERIALIZABLE",
				`chrome.${dotted} returned a non-serializable value`,
				"This chrome API returns a handle/port/stream; use browser.cdp or a dedicated wrapper.",
			);
		}
	}

	// ── read ───────────────────────────────────────────────────────────────────
	private async read(opts: { format?: string }): Promise<unknown> {
		const format = opts.format || "snapshot";
		await attachActiveTab();
		if (format === "snapshot") {
			return cdp("DOMSnapshot", "captureSnapshot", { computedStyles: [] });
		}
		if (format === "ax") {
			return cdp("Accessibility", "getFullAXTree", {});
		}
		// 'readability' was removed: it required importing @mozilla/readability from
		// a remote CDN inside the PRIVILEGED side-panel document, which the
		// extension_pages CSP (`script-src 'self'`) blocks unconditionally — it
		// could never succeed. Use 'snapshot' or 'ax' instead.
		throw new CdpError("BAD_FORMAT", `Unknown read format: ${format}`, "Use 'snapshot' (DOM) or 'ax' (accessibility tree).");
	}

	// ── tab context ────────────────────────────────────────────────────────────
	private async activeTab(): Promise<unknown> {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (!tab?.id) {
			throw new CdpError("NO_ACTIVE_TAB", "No active tab", "Focus a tab and retry.");
		}
		return { tabId: tab.id, url: tab.url || "", title: tab.title || "", favicon: tab.favIconUrl };
	}

	private async tabs(): Promise<unknown> {
		const all = await chrome.tabs.query({});
		return all
			.filter((t) => t.id != null)
			.map((t) => ({
				tabId: t.id,
				url: t.url || "",
				title: t.title || "",
				active: !!t.active,
				groupId: (t as any).groupId ?? -1,
			}));
	}

	// ── groups ───────────────────────────────────────────────────────────────--
	private async groupsCreate(tabIds: number[], opts: { title?: string; color?: string }): Promise<number> {
		const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] });
		if (opts.title || opts.color) {
			await chrome.tabGroups.update(groupId, {
				...(opts.title ? { title: opts.title } : {}),
				...(opts.color ? { color: opts.color as `${chrome.tabGroups.Color}` } : {}),
			});
		}
		return groupId;
	}

	// ── built-in AI (gated on availability) ──────────────────────────────────--
	private async ai(prompt: string, opts: { system?: string; task?: string }): Promise<string> {
		const g = self as any;
		const task = opts.task || "prompt";
		const ensure = async (api: any, name: string) => {
			if (!api || typeof api.availability !== "function") {
				throw new CdpError("AI_UNAVAILABLE", `${name} is not present`, "Chrome built-in AI is not available in this build/profile.");
			}
			const avail = await api.availability();
			if (avail === "unavailable") {
				throw new CdpError(
					"AI_UNAVAILABLE",
					`${name} availability() === 'unavailable'`,
					"On-device model unavailable (needs desktop, >4GB VRAM, ~22GB disk).",
				);
			}
		};

		if (task === "summarize") {
			await ensure(g.Summarizer, "Summarizer");
			const s = await g.Summarizer.create();
			return s.summarize(prompt);
		}
		if (task === "detect") {
			await ensure(g.LanguageDetector, "LanguageDetector");
			const d = await g.LanguageDetector.create();
			const results = await d.detect(prompt);
			return JSON.stringify(results);
		}
		if (task === "translate") {
			await ensure(g.Translator, "Translator");
			throw new CdpError(
				"AI_TRANSLATE_ARGS",
				"translate needs source/target languages",
				"Use browser.chrome / self.Translator.create({sourceLanguage,targetLanguage}) directly for translation.",
			);
		}
		// default: prompt
		await ensure(g.LanguageModel, "LanguageModel");
		const session = await g.LanguageModel.create(opts.system ? { initialPrompts: [{ role: "system", content: opts.system }] } : {});
		return session.prompt(prompt);
	}

	// ── fork (js-interpreter realm hosted in a singleton offscreen doc) ────────--
	private async ensureOffscreen(): Promise<void> {
		if (this.offscreenReady) return;
		const anyChrome = chrome as any;
		if (!anyChrome.offscreen) {
			throw new CdpError("OFFSCREEN_UNAVAILABLE", "chrome.offscreen not available", "Offscreen API requires Chrome 109+ and the 'offscreen' permission.");
		}
		try {
			const has = await anyChrome.offscreen.hasDocument?.();
			if (!has) {
				await anyChrome.offscreen.createDocument({
					url: "offscreen.html",
					reasons: ["WORKERS"],
					justification: "forkable JS realm (js-interpreter) + pdf",
				});
			}
			this.offscreenReady = true;
		} catch (e: any) {
			// "Only a single offscreen document" → already exists, fine.
			if (String(e?.message || e).includes("single offscreen")) {
				this.offscreenReady = true;
				return;
			}
			throw new CdpError("OFFSCREEN_FAILED", e?.message || String(e), "Could not create the offscreen document for browser.fork.");
		}
	}

	private async fork(src: string): Promise<{ snapshot: unknown }> {
		// Cheap guard: deterministic, synchronous only.
		if (/\b(await|import|fetch|Promise)\b/.test(src)) {
			throw new CdpError(
				"FORK_ASYNC",
				"fork() functions must be synchronous and deterministic",
				"Remove await/import/fetch/Promise; browser.fork is for checkpointing deterministic logic, not page/async code.",
			);
		}
		await this.ensureOffscreen();
		// The offscreen doc hosts js-interpreter and returns a serialized state stack.
		// Until the offscreen document + message channel are shipped, surface a clear
		// typed "not wired" error rather than faking a fork.
		throw new CdpError(
			"FORK_UNWIRED",
			"browser.fork is not yet wired to the offscreen js-interpreter host",
			"The js-interpreter dep + getStateStack/setStateStack path is designed but the offscreen.html host is not shipped in this build. Use deterministic JS in the REPL directly for now.",
		);
	}

	private async forkResume(_stack: unknown): Promise<unknown> {
		throw new CdpError(
			"FORK_UNWIRED",
			"browser.fork resume is not yet wired",
			"Offscreen js-interpreter host not shipped; see browser.docs('fork').",
		);
	}

	getDescription(): string {
		return renderPromptDocs();
	}
}
