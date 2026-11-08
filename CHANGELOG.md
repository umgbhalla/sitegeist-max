# Changelog

## [Unreleased]

### Fixed

- Keep slow verification work running past the ten-second target in both extensions, with one five-minute maximum, versioned budget evidence, and causal cancellation messages.

- Treat a single Tencent reference-strip element as three symbols by default, log how references were counted, and require the planned marker count before clicking OK.

- Start verification controls at page startup, detect CSS-only visibility changes, reconnect existing tabs after extension reload, and guard missing extension messaging connections.

- Remove premature per-request Jev timeouts, clear completed timers, preserve timeout evidence, and reuse rotation mappings to leave more of the attempt budget for model decisions and input.

- Isolate mock builds in `dist-chrome-e2e` so UI tests cannot replace the installed extension. Preserve existing subscription credentials during test startup and clear fake keys left by older builds.

- Screenshot capture now requests `<all_urls>` so normal web tabs can be captured without a temporary toolbar-click grant.
- Reasoning picker follows model capabilities, including Extra High and Max. GPT-6.1 Sol excludes Off and Minimal; GPT-6 Luna supports Off as none. Saved unsupported levels are clamped before use.

### Added

- Add a standalone verification history sidebar with an activity timeline, recording switch, automatic and date-range exports, and delete-all control.

- Record transport request mappings, sanitized response bodies, cache correlations, and per-run evidence coverage.

- Local verification telemetry shared by both extensions: persistent run/image/script evidence, exact crop transforms, human outcome labels, recent-run exports, an agent recording tool, and an offline dataset unpacker.

- Shared Verification SDK with one public client API for both extensions, injected private configuration, an importable ES module, and TypeScript declarations.

- Standalone Jev Verification Chrome extension with a page button, one manual attempt per click, exact-input response caching, batched shape checks, a bounded disagreement branch, and a separate private distribution.

- General browser code mode: authenticated page adapters, persistent network response capture, original download ingestion, full-page evidence screenshots, immutable packet files and validated ZIP exports.
- Versioned agent-written tools and offscreen background jobs with durable checkpoints, bounded retries, progress, cancellation, and resume controls.
- Google Sheets OAuth identity verification and atomic new-tab-only writes without changing existing cells or sharing.

- GPT-6.1 Terra for OpenAI and ChatGPT subscriptions, including its reasoning levels, prices, and saved Terra selection migration.

- Added web search through configured TinyFish, Exa, and Parallel API keys, with rotation and fallback, including keyless Exa and Parallel search.

- Expanded the navigate tool with tab controls for blank tabs, closing, duplicating, reloading, pinning, unpinning, and moving tabs.
- Added REPL helpers for composing previous tool outputs with normal JavaScript: listToolResults(), getToolResult(), getToolResults(), and getLastToolResult().
- Browser-native dynamic workflows: a `workflow` tool that runs a JavaScript orchestration script (`agent()`/`parallel()`/`phase()`/`log()`) spawning isolated pi sub-agents in the sidepanel, with a live progress panel and IndexedDB run history. The sandbox also exposes `getArtifact()`/`listArtifacts()` so scripts pull real data from session artifacts instead of the model inlining it. Sub-agents can be `agentType: "browser"` — each gets its own background tab with navigate + browserjs scoped to it (run them one at a time; the browser is shared). A live workflow debug log (Bug toggle in the header) tails every run event below the input; each sub-agent turn is bounded by a 180s timeout; run start logs injected `args` (keys + byte sizes) and flags placeholder-looking values, and script errors surface an actionable hint (message + stack + available arg keys + defensive-parsing reminder).
- End-to-end UI test harness (Playwright loads the real MV3 extension; in-process mock LLM) covering the chat shell and the workflow panel.
- Steering: messages sent while a run is busy join it after the current tool round (Enter), or queue as the next run (Alt+Enter). Queued messages show above the composer and can be cleared; Stop and Esc drop them.
- `ask_user` tool: the agent asks up to 4 multiple-choice questions (each with a free-text Other) inline in the transcript and waits; the user answers or skips.
- Queued messages can be removed, edited (moved back into the composer), moved up, and switched between steering the current run and running next.
- Up/Down in the composer recall previously sent prompts.
- Navigate and web search steps show the pages they touched as source chips; web search has its own renderer with the result count.
- Add a visual symbol comparison tool for rotated and scaled verification images, with an optional single Tencent attempt that checks for changed images and acknowledges each selection.
- Add optional local Typesafe Jev configuration and a bounded grid, candidate-selection, and crop-check workflow, with per-stage model, probability, token, and timing evidence.
- Add an attempt-oriented Jev policy and one budgeted aligned-comparison refinement per uncertain target before handing off.

### Fixed

- Tool calls stay visible while they execute; previously a call disappeared from the transcript between its message ending and its result arriving.
- Improved screenshot access and errors, native input error reporting, and verification handoff guidance.
- Exclude enclosed icon details and partial contrast-mask duplicates from symbol proposals, and ask focused verification questions when recognition remains uncertain.
- Include state-specific next-action instructions in verification tool results, directing the agent to click and verify clear matches while preserving pending input and submission acknowledgements.
- Wait longer for delayed selection markers within the shared attempt deadline without repeating mouse input.

### Changed

- Preserve verification recordings until deletion, remove fixed event and asset limits, and export all runs by default.

- Share the standalone Jev completion runner with the main agent tool: no confidence-score cutoff, exact-input caching, bounded comparison branches, and timed local proposals within the shared attempt budget.

- Verification completion defaults to Jev, automatic reference-count detection, ordered clicks, submission, and outcome checks with an empty tool argument object. Analysis-only and local-math modes remain optional overrides.
- CDP commands run without per-call extension confirmation dialogs. Retries retain the original target tab.

- Artifacts are six single-purpose tools (`artifact_create`, `artifact_edit`, `artifact_write`, `artifact_read`, `artifact_delete`, `artifact_logs`) with all-required parameters, replacing the overloaded `artifacts` tool and its `command` field. Failures are error results instead of `Error:` text. Previews resolve through an extension-keyed viewer registry. Sessions saved with the old tool still render and rebuild their files.
- Generated files stay collapsed until opened. A Files control and keyboard-accessible preview cards open a docked preview that keeps chat controls visible; background file changes preserve the selected preview.
- Side panel UI uses the Fluid Functionalism design system: its surface, text, border and accent tokens, Inter, grey user bubbles, and a step column for thinking and tool calls (icon gutter, connector line, shimmering label while running). Dark mode is the default; Settings offers Dark, Light and System.
- Chat, History and Settings are top-level tabs in a fixed bar instead of modals. Views stay mounted while hidden, so a running chat keeps streaming. The chat tab shows the session title (double-click to rename) and the model in its tooltip.
- Every turn answering one user message renders as one run: a single step column across turns and one summary line (duration, step count, cost; token detail on hover) instead of a usage line under every turn. The tab bar truncates the session title instead of overflowing.

- OpenAI and ChatGPT model choices now use GPT-6.1 Sol (default) and GPT-6 Luna, with current context limits and pricing. Saved OpenAI selections refresh when resumed; configured ChatGPT/OpenAI providers take priority for new chats. Astra is excluded.
- General and global tasks no longer inherit the active tab as their scope. Browser context is optional in the system and navigation prompts.
- Chat uses neutral light/dark colors, right-aligned user bubbles, a rounded composer, and clearer send/stop controls.

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
