import { Agent, type AgentState, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { wfDebug } from "./workflow-debug-bus.js";

export interface SubagentSpec {
	prompt: string;
	tier?: "small" | "medium" | "big";
	model?: { provider: string; id: string };
	systemPrompt?: string;
	/** "browser" gives the sub-agent navigate + browserjs bound to its OWN tab. */
	agentType?: "reason" | "browser";
}

export interface SubagentResult {
	text: string;
	usage?: unknown;
	tier?: string;
	model?: string;
}

export type SpawnSubagent = (spec: SubagentSpec) => Promise<SubagentResult>;

// pi Agent option types are broad; a loose alias keeps the deps object simple.
type AgentDep = any;

/** Per-run browser support: allocate a dedicated tab and build tools bound to it. */
export interface BrowserSubagentDeps {
	allocateTab: () => Promise<number>;
	releaseTab: (tabId: number) => Promise<void>;
	buildTools: (tabId: number) => AgentTool<any, any>[];
}

export interface SubagentDeps {
	streamFn: AgentDep;
	getApiKey: AgentDep;
	convertToLlm: AgentDep;
	/** Fallback model (the primary agent's current model) when spec gives none. */
	defaultModel: () => Model<any> | undefined;
	/** Present when the host can hand browser sub-agents their own tab + tools. */
	browser?: BrowserSubagentDeps;
}

// Hard ceilings for a single sub-agent turn; a stalled stream becomes an error
// (visible in the workflow debug log) instead of an infinite hang. Browser
// agents run multiple tool turns (navigate + browserjs), so they get longer.
const SUBAGENT_TIMEOUT_MS = 180_000;
const BROWSER_TIMEOUT_MS = 300_000;

const SUBAGENT_SYSTEM =
	"You are a focused sub-agent running inside a workflow. Complete the single task described in the prompt and reply with only the result — no preamble.";

const BROWSER_SUBAGENT_SYSTEM =
	"You are a browser sub-agent inside a workflow with your OWN dedicated tab. Use the navigate tool to open a URL, then the repl tool's browserjs() to read/interact with that page. You MUST navigate to a real http(s) page before calling browserjs (it rejects about:/chrome:// pages). Do the task and reply with only the result — no preamble.";

// Coarse tier -> model routing, layered on the anthropic defaults already bundled.
const TIER_MODELS: Record<string, [string, string]> = {
	small: ["anthropic", "claude-haiku-4-5"],
	medium: ["anthropic", "claude-sonnet-4-6"],
	big: ["anthropic", "claude-opus-4-6"],
};

function pickModel(spec: SubagentSpec, deps: SubagentDeps): Model<any> | undefined {
	if (spec.model) {
		const m = getModel(spec.model.provider as any, spec.model.id);
		if (m) return m;
	}
	if (spec.tier && TIER_MODELS[spec.tier]) {
		const [p, id] = TIER_MODELS[spec.tier];
		const m = getModel(p as any, id);
		if (m) return m;
	}
	return deps.defaultModel();
}

function extractText(msg: { content: unknown }): string {
	const content = msg.content as Array<{ type: string; text?: string }> | string;
	if (typeof content === "string") return content;
	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text as string)
		.join("");
}

/**
 * Builds a spawner that runs one prompt through a throwaway Agent to idle and
 * returns its final text. The Agent config (streamFn/getApiKey/convertToLlm) is
 * the SAME one the primary agent uses, so the e2e mock gate applies here too.
 */
export function buildSubagentSpawner(deps: SubagentDeps): SpawnSubagent {
	return async (spec) => {
		const model = pickModel(spec, deps);
		if (!model) {
			throw new Error(
				`no model resolved (tier=${spec.tier ?? "-"}, model=${spec.model?.id ?? "-"}, and no default)`,
			);
		}

		const browserMode = spec.agentType === "browser" && !!deps.browser;
		let tabId: number | undefined;
		let tools: AgentTool<any, any>[] = [];
		let systemPrompt = spec.systemPrompt ?? SUBAGENT_SYSTEM;
		const timeoutMs = browserMode ? BROWSER_TIMEOUT_MS : SUBAGENT_TIMEOUT_MS;

		if (browserMode) {
			tabId = await deps.browser!.allocateTab();
			tools = deps.browser!.buildTools(tabId);
			systemPrompt = spec.systemPrompt ?? BROWSER_SUBAGENT_SYSTEM;
			wfDebug(`  ↳ browser sub-agent · tab ${tabId} · ${tools.length} tools`);
		}

		try {
			const sub = new Agent({
				initialState: {
					systemPrompt,
					model,
					thinkingLevel: "medium",
					messages: [],
					tools,
				} as Partial<AgentState>,
				convertToLlm: deps.convertToLlm,
				toolExecution: "sequential",
				streamFn: deps.streamFn,
				getApiKey: deps.getApiKey,
			});
			wfDebug(`  ↳ prompt sent to ${(model as any)?.id ?? "?"} · awaiting idle…`);
			await sub.prompt(spec.prompt);
			// Bound the wait: a sub-agent whose stream never settles would otherwise
			// hang the whole workflow until the 30min sandbox cap. Turn it into a
			// visible error instead.
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					sub.waitForIdle(),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`sub-agent timed out after ${timeoutMs / 1000}s (no idle)`)),
							timeoutMs,
						);
					}),
				]);
			} catch (e) {
				try {
					sub.abort();
				} catch {}
				throw e;
			} finally {
				clearTimeout(timer);
			}
			wfDebug(`  ↳ idle · ${sub.state.messages.length} msgs`);
			const last = [...sub.state.messages].reverse().find((m) => m.role === "assistant");
			return {
				text: last ? extractText(last) : "",
				usage: (last as any)?.usage,
				tier: spec.tier,
				model: (model as any)?.id,
			};
		} finally {
			if (tabId !== undefined) await deps.browser!.releaseTab(tabId).catch(() => {});
		}
	};
}
