# Verification SDK

One Chrome extension engine for Sitegeist and the standalone Jev extension. Both adapters import `src/verification-sdk/index.ts`; recognition, caching, deadlines, native input, marker acknowledgements, and outcome handling live here.

```text
VerificationClient.verify(request)
  +-- Sitegeist agent tool adapter
  +-- Standalone extension background adapter

SDK engine
  +-- Jev recognition and local image proposals
  +-- Per-client exact-input response cache
  +-- Chrome frame discovery and native input
  +-- Shared budget and outcome state machine
```

## Build

From the repository root:

```sh
node scripts/build-verification-sdk.mjs
```

This creates `dist-verification-sdk/index.js`, its source map, TypeScript declarations, and a private package manifest named `@sitegeist/verification-sdk`. The bundle has no third-party runtime dependencies, agent/UI code, local config files, or embedded credential. It is an ES module for Chrome extension contexts, not a content-script or Node browser driver.

Both extensions compile this same source directly. Their existing build commands remain `node scripts/build.mjs` and `node scripts/build-verification.mjs`.

## Use

```ts
import { VerificationClient } from "./dist-verification-sdk/index.js";

const verification = new VerificationClient({
  loadConfig: async () => ({
    apiKey: "YOUR_LOCAL_API_KEY",
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
  }),
});

const { id: windowId } = await chrome.windows.getCurrent();
if (windowId === undefined) throw new Error("No browser window");
const result = await verification.verify({ windowId });
```

Keep the real credential in private extension configuration and return it from `loadConfig`. Sitegeist and the standalone extension use the shared `src/verification-config.ts` adapter to load their ignored `typesafe.local.json`. The SDK itself does not read `.env` or extension-specific files.

Call from a service worker or privileged extension page with `tabs`, `scripting`, `debugger`, and the required host permissions. The active tab must contain a supported Tencent ordered-symbol challenge. An optional `tabId` pins the expected active tab; `signal` supports caller cancellation.

`verify({windowId})` discovers references, uses Jev, clicks in order, checks each numbered marker, submits once, and inspects the outcome. Ten seconds is a target; the maximum is five minutes. No confidence-score cutoff blocks a valid selection. A changed challenge, missing marker, invalid response, cancellation, or failure stops the attempt. No request, click, or submission is retried automatically.

Diagnostic options remain `attempt:false`, `method:"shape"` or `"auto"`, `count`, and paired `reference`/`scene` bounds. Explicit bounds require `attempt:false`. Diagnostics and normal completion use the same `verify` API.

The result contains rankings, Jev stages and match evidence, reference count/layout, interaction events, `nextAction`, elapsed time, and versioned budget metadata. `accepted:true` records selection for an attempt; confirmed success is `interaction.status === "success"`. A `VerificationCompletionError` includes `phase`, `elapsedMs`, and `budget`.

## Local telemetry

Every SDK call records local calibration evidence by default, including errors and analysis-only calls. `result.telemetry` identifies its saved record; `verificationTelemetryReference(error)` retrieves the same small reference from an error. `client.telemetry` exposes `listRuns`, `labelRun`, `exportRuns`, and `clearRuns`. Records include exact Jev PNGs, geometry/crop transforms, model decisions, sanitized iframe/scripts, and interaction evidence. Credentials stay outside the recorder. Exported assets are deduplicated and hash-checked.

The local store retains up to 50 runs or 512 MiB. It checkpoints unfinished runs, preserves manual labels during later writes, and reports unavailable storage without changing the verification outcome. `telemetry:false` is an SDK constructor override for callers that explicitly need no recording; both shipped extensions leave recording enabled. Capture requires a privileged extension context with IndexedDB. There is no telemetry server.

See [recording/export and calibration instructions](../../docs/verification-telemetry.md) for the dataset schema, limits, and offline unpack command. Public script copies are bounded anonymous GETs after the attempt; collected source is not executed.

Each client owns a 64-entry response cache with a 60-second TTL. Reuse one client per extension runtime. `clearCache()` clears completed responses. Coordinates, clicks, marker counts, and success state are never cached. Normal completion attempts share a window lock within the runtime. Independent extensions have independent runtimes and must not operate on the same challenge simultaneously.

## Validate

```sh
node --import tsx --test --test-concurrency=1 tests/verification-*.test.ts tests/typesafe-verification.test.ts
```

The suite checks both application adapters, native three-click completion on cross-origin mock pages, slow responses, cancellation, cache reuse, SDK imports, and consumer declaration typechecking. A full five-minute stalled-request replay is opt-in:

```sh
JEV_TEST_LONG_TIMEOUT=1 node --import tsx --test tests/verification-standalone-browser.test.ts
```

These checks do not establish live Tencent acceptance.
