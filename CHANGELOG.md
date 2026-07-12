# Changelog

## [Unreleased]

### Added

- Expanded the navigate tool with tab controls for blank tabs, closing, duplicating, reloading, pinning, unpinning, and moving tabs.
- Added REPL helpers for composing previous tool outputs with normal JavaScript: listToolResults(), getToolResult(), getToolResults(), and getLastToolResult().
- Backfilled recent models the pinned pi-ai 0.75.5 catalog was missing, copied verbatim from upstream pi-ai 0.80.6 via patch-package: `claude-opus-4-8`, `claude-sonnet-5`, and `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` (on both the `openai` and `openai-codex` providers). (pi-ai can't be upgraded past 0.75.x while pi-web-ui is capped at 0.75.3.)

### Changed

- Model picker now shows only the latest model of each lineage. Curation lives in `src/models/latest.ts` and is applied through a small hook patched into pi-ai's `getModels()`; `getModel()` is left unfiltered so saved/legacy model ids still resolve. Anthropic: Opus 4.8, Sonnet 5, Haiku 4.5 (Fable excluded). OpenAI + OpenAI Codex: the 5.6 tiers gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna. Providers without a curated list are unchanged.
- Default models updated to the current latest: Anthropic `claude-sonnet-5`, OpenAI `gpt-5.6-sol`, OpenAI Codex `gpt-5.6-sol`.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
