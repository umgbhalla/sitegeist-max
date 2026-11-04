import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";

// Latest-per-lineage model curation.
//
// The pi-ai catalog ships every model a provider ever exposed (gpt-4, o1,
// claude-3, ...). We only want the newest model of each lineage to appear in
// the model picker. This module owns that policy as data; a small hook patched
// into pi-ai's getModels() (see patches/@earendil-works+pi-ai+*.patch) applies
// it.
//
// Rules:
// - A provider listed here is filtered to exactly the ids in its set (order in
//   the picker follows the catalog order, which is newest-first per lineage).
// - A provider NOT listed here is left untouched (all models shown).
// - getModel(provider, id) is never filtered, so a saved/legacy model id still
//   resolves and keeps working.
//
// Catalog additions below bridge releases that the installed pi-ai catalog lacks.

export const LATEST_MODELS: Record<string, string[]> = {
	// Anthropic: latest of each tier. Fable is intentionally excluded.
	anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
	openai: ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
	"openai-codex": ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"],
};

const ALLOW: Record<string, Set<string>> = Object.fromEntries(
	Object.entries(LATEST_MODELS).map(([provider, ids]) => [provider, new Set(ids)]),
);

type MinimalModel = { id: string };

/** Filter a provider's model list to the latest-per-lineage allowlist. */
export function filterLatestModels<T extends MinimalModel>(provider: string, models: T[]): T[] {
	const allow = ALLOW[provider];
	return allow ? models.filter((m) => allow.has(m.id)) : models;
}

/**
 * Install the filter into pi-ai's getModels() via the global hook the patch
 * reads. Call once, early, before any model list is rendered.
 */
export function installLatestModelFilter(): void {
	installOpenAIModels();
	(globalThis as { __PI_MODEL_FILTER__?: typeof filterLatestModels }).__PI_MODEL_FILTER__ = filterLatestModels;
}

const OPENAI_CATALOGS: Record<string, Record<string, Model<Api>>> = {
	openai: OPENAI_MODELS,
	"openai-codex": OPENAI_CODEX_MODELS,
};

// shortcut: installed pi-ai lacks these models, remove backfill when its catalog includes them.
// Specs and Standard prices: developers.openai.com/api/docs/models and /pricing.
function installOpenAIModels(): void {
	for (const catalog of Object.values(OPENAI_CATALOGS)) {
		for (const [id, name, input, output, cacheRead] of [
			["gpt-6.1-sol", "GPT-6.1 Sol", 2, 10, 0.1],
			["gpt-6.1-terra", "GPT-6.1 Terra", 1, 5, 0.05],
			["gpt-6-luna", "GPT-6 Luna", 0.1, 0.5, 0.01],
		] as const) {
			catalog[id] ??= {
				...catalog["gpt-5.6-sol"],
				id,
				name,
				contextWindow: 1_050_000,
				maxTokens: 128_000,
				thinkingLevelMap: { off: id === "gpt-6.1-sol" ? null : "none", minimal: null, xhigh: "xhigh", max: "max" },
				cost: {
					input,
					output,
					cacheRead,
					cacheWrite: input * 1.25,
					tiers: [
						{
							inputTokensAbove: 272_000,
							input: input * 2,
							output: output * 1.5,
							cacheRead: cacheRead * 2,
							cacheWrite: input * 2.5,
						},
					],
				},
			};
		}
	}
}

/** Refresh saved OpenAI selections without changing other providers or history. */
export function refreshOpenAIModel<T extends Model<Api>>(model: T): Model<Api> {
	const catalog = OPENAI_CATALOGS[model.provider];
	if (!catalog) return model;
	const id = LATEST_MODELS[model.provider].includes(model.id)
		? model.id
		: model.id.includes("luna")
			? "gpt-6-luna"
			: model.id.includes("terra")
				? "gpt-6.1-terra"
				: "gpt-6.1-sol";
	return catalog[id];
}

export function getDefaultOpenAIModel(provider = "openai-codex"): Model<Api> {
	return OPENAI_CATALOGS[provider]["gpt-6.1-sol"];
}
