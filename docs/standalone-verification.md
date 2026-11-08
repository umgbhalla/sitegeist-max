# Jev Verification Chrome extension

Load `/Users/zeus/hub/sitegeist-max/dist-verification-chrome` using **Load unpacked** at `chrome://extensions` with Developer mode enabled. Reload the extension to apply a rebuilt version. Existing web tabs receive a fresh control automatically, without refreshing the page or challenge. The extension toolbar action can also restore the control. This is a separate extension from Sitegeist; its distribution does not replace `dist-chrome`.

When a visible Tencent ordered-symbol frame appears, the page shows **Complete verification**. Click it to start one attempt. There is no agent, chat, automatic start, automatic refresh, or automatic retry. **Hide** dismisses the component. The component hides during the attempt so it cannot cover the screenshot or intercept target clicks, then shows the result and a downloadable JSON log.

Detection starts at `document_start`, without waiting for DOMContentLoaded, page load, debugger attachment, configuration, or Jev. DOM changes schedule an immediate microtask; a local 100 ms visibility check catches CSS-only changes that do not create mutation records. These checks do not call the model or extension background. Reinjection disposes previous controls, checks whether an existing connection is healthy, and guards missing `chrome.runtime` before messaging. This uses Chrome's documented [early content script injection](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts). The control test verifies appearance during a blocked page load and recovery after the real Chrome extension Reload button, preserving the original document.

## Recordings

Every SDK run now records [local calibration evidence](verification-telemetry.md), including analysis and errors. Use **Export latest 20 runs**, **Export this run with images**, and **Save observed result**. The extension toolbar action opens saved-history controls even when the challenge is gone. Images, sanitized iframe/scripts, exact crop transforms, model decisions, and click outcomes remain in local extension storage.

## Build and credentials

```sh
node scripts/build-verification.mjs
```

The script reads the existing private `.env`: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, and `TYPESAFE_DEFAULT_MODEL`. The model defaults to `jev-latest`. The key goes into `dist-verification-chrome/typesafe.local.json` with file mode `0600`. Both `.env` and this entire distribution are ignored by Git. The key is absent from JavaScript, source maps, the manifest, page scripts, and attempt logs. The config is not web-accessible. Keep this local build private: it includes your credential.

Chrome grants this extension `tabs`, `scripting`, `debugger`, and `<all_urls>` access for frame discovery, active-tab capture, the API, and native input. The debugger attaches before measuring the viewport and detaches after the attempt. Capture uses the current page surface without a clip or emulation override. Pixel scale comes from screenshot width; a cropped screenshot height must not stretch Y coordinates. Every challenge region must fit inside the captured image. If DevTools or another extension owns the debugger, Chrome can refuse attachment; close that debugger before trying again.

## Runtime

```text
visible challenge -> page button -> trusted user click
  -> lock attempt + attach debugger + pin active tab
  -> discover frame/references + measure screenshot scale
  -> grid Choice + rotation/contrast candidates
  -> per-target batched Choice, outline Choice, candidate Nouls
       | choices agree: retain selection
       | choices disagree + time remains: aligned comparison once
       | comparison unavailable: retain initial valid selection
  -> fresh image/layout/identity checks
  -> click 1 -> marker 1 -> click 2 -> marker 2 -> click 3 -> marker 3
  -> submit once -> success / failure / changed / unconfirmed
  -> unlock + show evidence; next attempt requires another user click
```

There are no probability, score, or margin gates in the shared completion policy. Jev's choices produce the attempted sequence even when all match scores are low. Evidence reports `thresholds: null`; `accepted: true` means selected for an attempt under this policy, not proven correct. Both applications now import the public `VerificationClient` from `src/verification-sdk/index.ts`. The shared SDK also builds to the credential-free `dist-verification-sdk` ES module with TypeScript declarations. The main Sitegeist agent tool uses this same runner and policy by default with `verification_shape_match({})`. Both entry points share caching, branch decisions, debugger setup, reference counting, marker handling, and deadline cleanup. Low-level gated diagnostics remain available for comparison.

A single instruction image or `.tc-instruction-icon` can contain all three reference symbols. It is split into three crops by default; a DOM element is not a symbol count. Multiple separate reference elements supply their count directly. The log records `referenceLayout` as well as `referenceCount`. The click plan must match that count, and the submit driver requires all expected numbered markers before OK. An explicit count override remains available in the Sitegeist diagnostic tool for genuine single-symbol tasks.

Coordinates must still exist and be valid. A missing frame, malformed response, API error, tab change, moved frame, changed image, deadline, or missing selection acknowledgement can stop the sequence. A dispatched event is not an acknowledgement. A changed challenge invalidates the sequence. A disappearing dialog alone does not establish success.

Both entry points target ten seconds, with a shared five-minute maximum for one attempt including discovery, recognition, input, and outcome polling. Crossing ten seconds does not cancel useful work. The result includes `budget.version`, `targetMs`, `limitMs`, and `targetExceeded` so an old loaded extension or a slow attempt can be identified. Local candidate search uses 24-pixel masks, proportional stroke tolerance, 12 coarse angles, and 18 refinement angles. Its budget is at most 2.5 seconds, leaving time for Jev decisions and input. The log reports this CPU work as `local_proposals`; the legacy 48-pixel diagnostic search is unchanged. Each API call can use the remaining recognition budget, reserving 1.5 seconds for input; there is no separate 2.5-second cutoff. Timers are cleared after completion or failure. Up to three target decisions run concurrently, without retries. An aligned comparison requires at least three seconds remaining. The deadline is a bound on further actions, not a promise of a successful completion. Timeout results retain stage timings and errors; setup failures also produce a downloadable log. Elapsed time includes setup.

## Cache and branching

The cache follows the cookbook's application-side exact-input approach. SHA-256 keys cover API origin, model, account identity, exact image bytes, question text, and candidate labels. It holds up to 64 responses for at most 60 seconds in the worker's memory. Worker termination clears it. Identical in-flight requests share one promise. Failed responses are never cached; unresolved or failed attempts clear prior entries. Results are cloned so callers cannot mutate cached answers.

The cache never stores coordinates, marker counts, click events, or success state. Every click attempt discovers the current layout, captures the current pixels, maps candidates afresh, and validates the page again. Responses are reused only for identical visual questions.

Each target request asks a complete-symbol Choice, an outline Choice, and a matching Noul for every candidate. These are independent questions over the same images, not a majority vote or calibrated confidence estimate. A disagreement among the initial Choice, outline Choice, and highest Noul builds a shortlist of up to three candidates. One further Choice compares aligned reference/candidate pairs. It always selects a candidate; there is no confidence rejection path. If that comparison cannot finish, the initial valid selection remains available until the overall deadline.

This adapts the official [speculative fan-out pattern](https://docs.typesafe.ai/patterns/fan-out), [parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions), [shortlist and cache example](https://docs.typesafe.ai/cookbooks/skill_suggestion), and [OCR crop checks](https://docs.typesafe.ai/cookbooks/ocr_confidence_bounding_boxes). The [image API](https://docs.typesafe.ai/images) defines shared asset references, multipart uploads, image placement, and size limits. The examples repository was inspected at [484f0dde9179af954784870200ed839f6394a33c](https://github.com/typesafe-ai/typesafe-public-examples/tree/484f0dde9179af954784870200ed839f6394a33c). No provider-side persistent asset cache is assumed.

## Evidence

The isolated Chrome test loads this extension's actual manifest, service worker, and content script against a cross-origin Tencent-shaped test page. It covers the manual trigger, refusal of synthetic clicks, native ordered input, visible acknowledgements, one submission, explicit success, exact-input cache reuse, a disagreement branch that changes the selection, and HTTP 429 without a retry. It also delays a grid response by eleven seconds and verifies that the attempt completes all three clicks and submission after the former ten-second cutoff. The five-minute stalled-request replay is available with `JEV_TEST_LONG_TIMEOUT=1`; quick unit tests cover deadline cancellation without waiting five minutes. The main agent tool has the same eleven-second regression test. Mock Choice probabilities were at most 0.25 and match Nouls were 0.01, demonstrating that confidence gates do not block this policy.

The current shared-runner replay on 2026-11-08 selected all 21 annotated targets across seven supplied screenshots. Recognition took 1.701 to 2.525 seconds; local proposal work took 112 to 326 ms. A current controlled replay forced the three initial choices to the wrong candidate; the real comparison branches recovered all three correct targets in 2.964 seconds. This is branch execution evidence, not an unmodified model-accuracy sample. All 50 verification tests and the required project checks passed. The main-tool test calls the default `{}` and verifies native ordered input even with low model scores. These are saved-image and isolated-browser results, not live Tencent acceptance.

An earlier real Typesafe API replay selected all 21 annotated targets across seven supplied screenshots. Recognition times were 3.436 to 5.906 seconds. These were read-only recognition replays, not live submissions. The natural examples used the initial batched path. A controlled real-API branch test on `68280` forced the three initial Choice answers to the wrong candidate `c1`; real outline answers, Nouls, and aligned comparison requests then selected all three correct `c0` candidates in 7.511 seconds. This is fault injection, not a naturally occurring success-rate sample. The results do not establish guaranteed CAPTCHA acceptance or a general success rate. Provider image support is experimental in the current documentation.

```sh
node --import tsx --test --test-concurrency=1 tests/verification-*.test.ts tests/typesafe-verification.test.ts
VERIFICATION_POLICY=best-effort node --env-file=.env scripts/benchmark-verification.mjs
```

The benchmark sends only challenge crops to Typesafe and incurs API usage. Input hashes must match the saved geometry before replay. The compact replay evidence is in `standalone-verification-evidence.json`.
