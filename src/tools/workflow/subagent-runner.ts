import { Agent, type AgentState } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";

export interface SubagentSpec {
	prompt: string;
	tier?: "small" | "medium" | "big";
	model?: { provider: string; id: string };
	systemPrompt?: string;
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

export interface SubagentDeps {
	streamFn: AgentDep;
	getApiKey: AgentDep;
	convertToLlm: AgentDep;
	/** Fallback model (the primary agent's current model) when spec gives none. */
	defaultModel: () => Model<any> | undefined;
}

const SUBAGENT_SYSTEM =
	"You are a focused sub-agent running inside a workflow. Complete the single task described in the prompt and reply with only the result — no preamble.";

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
		const sub = new Agent({
			initialState: {
				systemPrompt: spec.systemPrompt ?? SUBAGENT_SYSTEM,
				model,
				thinkingLevel: "medium",
				messages: [],
				tools: [],
			} as Partial<AgentState>,
			convertToLlm: deps.convertToLlm,
			toolExecution: "sequential",
			streamFn: deps.streamFn,
			getApiKey: deps.getApiKey,
		});
		await sub.prompt(spec.prompt);
		await sub.waitForIdle();
		const last = [...sub.state.messages].reverse().find((m) => m.role === "assistant");
		return {
			text: last ? extractText(last) : "",
			usage: (last as any)?.usage,
			tier: spec.tier,
			model: (model as any)?.id,
		};
	};
}
