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
// When a newer model ships: add its id here AND add the catalog entry via the
// patch (the catalog is generated upstream and lags real releases).

export const LATEST_MODELS: Record<string, string[]> = {
	// Anthropic: latest of each tier. Fable is intentionally excluded.
	anthropic: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
	// OpenAI: the current 5.6 tier system (flagship / balanced / cheap). The 5.6
	// generation replaced the old mini/nano/pro tier words with the sol/terra/luna
	// capability names, so these supersede the earlier per-tier lineages.
	openai: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
	// OpenAI Codex backend (ChatGPT subscription auth) exposes the same 5.6 tiers.
	"openai-codex": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
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
	(globalThis as { __PI_MODEL_FILTER__?: typeof filterLatestModels }).__PI_MODEL_FILTER__ = filterLatestModels;
}
