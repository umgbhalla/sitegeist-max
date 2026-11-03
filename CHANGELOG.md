# Changelog

## [Unreleased]

### Added

- Added web search through configured TinyFish, Exa, and Parallel API keys, with rotation and fallback, including keyless Exa and Parallel search.

- Expanded the navigate tool with tab controls for blank tabs, closing, duplicating, reloading, pinning, unpinning, and moving tabs.
- Added REPL helpers for composing previous tool outputs with normal JavaScript: listToolResults(), getToolResult(), getToolResults(), and getLastToolResult().
- Browser-native dynamic workflows: a `workflow` tool that runs a JavaScript orchestration script (`agent()`/`parallel()`/`phase()`/`log()`) spawning isolated pi sub-agents in the sidepanel, with a live progress panel and IndexedDB run history. The sandbox also exposes `getArtifact()`/`listArtifacts()` so scripts pull real data from session artifacts instead of the model inlining it. Sub-agents can be `agentType: "browser"` — each gets its own background tab with navigate + browserjs scoped to it (run them one at a time; the browser is shared). A live workflow debug log (Bug toggle in the header) tails every run event below the input; each sub-agent turn is bounded by a 180s timeout; run start logs injected `args` (keys + byte sizes) and flags placeholder-looking values, and script errors surface an actionable hint (message + stack + available arg keys + defensive-parsing reminder).
- End-to-end UI test harness (Playwright loads the real MV3 extension; in-process mock LLM) covering the chat shell and the workflow panel.

### Fixed

- Improved screenshot access and errors, native input error reporting, and verification handoff guidance.

### Changed

- Upgraded pi-ai / pi-agent-core to 0.80.6. pi-web-ui (frozen at 0.75.3, removed upstream) is vendored into `src/vendor/web-ui` and retargeted to `@earendil-works/pi-ai/compat`; the catalog now natively includes Opus 4.8, Sonnet 5, and the GPT-5.6 tiers (backfill patch no longer needed).
- Model picker shows only the latest model of each lineage. Curation lives in `src/models/latest.ts`, applied via a filter hook patched into pi-ai's `getBuiltinModels()`; `getModel()` stays unfiltered so saved/legacy ids still resolve. Defaults updated to Anthropic `claude-sonnet-5`, OpenAI / OpenAI Codex `gpt-5.6-sol`.

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
