# Typesafe Jev: ordered-symbol verification research

Updated and tested on 2026-11-08. This is an experimental integration, with measured limits. It is not evidence of a general CAPTCHA solver or live Tencent success.

## Current attempt policy

The main Sitegeist agent tool and standalone extension now use the same completion runner and attempt policy. This section supersedes the earlier gated policy; historical measurements below remain historical evidence.

Normal completion uses `verification_shape_match({})`: Jev, reference discovery, ordered native clicks, marker checks, one submission, and outcome polling are defaults. Multiple individual reference elements supply their count. One combined strip defaults to three symbols. Diagnostic calls can set `attempt:false`, `method:shape`, or explicit bounds. Missing Jev configuration is reported.

There are no confidence-score or margin cutoffs in the default Jev completion path. Results contain `thresholds:null`; `accepted:true` means selected for an attempt, not proven correct. Valid coordinates, unchanged pixels and layout, marker acknowledgements, cancellation, and the shared five-minute maximum still apply. Local-only shape diagnostics retain their existing gates. The old gated Jev implementation remains available only to low-level diagnostic callers.

```text
discover + capture -> grid -> bounded local proposals
  -> batched candidate Choice + outline Choice + Nouls
  -> agreement: retain choice
  -> disagreement + time available: one aligned comparison
  -> fresh pixels -> click -> marker -> next click
  -> all expected markers -> OK once -> inspect outcome
```

Up to three target decisions run concurrently. A disagreement branch requires three seconds remaining; if unavailable, the initial valid choice is retained. No request or input is retried automatically. Every API call reserves 1.5 seconds for input. Exact-input responses can be reused for 60 seconds; coordinates and interaction state are never cached. Failed or unresolved attempts clear cached responses.

Ten seconds is the completion target; one attempt may continue up to five minutes while the challenge remains current. The result logs the policy version and target/maximum budget. Sibling API cancellations preserve the original failure reason.

The shared runner attaches the debugger before measuring the viewport, pins the active tab, and disposes its timer and owned debugger connection after each attempt. Local proposals use a 24-pixel normalized mask with proportional stroke tolerance, 12 coarse angles and 18 refinement angles. This stage has a 2.5-second ceiling and an explicit `local_proposals` timing entry, preventing CPU search from silently consuming the entire attempt budget. The legacy 48-pixel, 72-angle diagnostic search is preserved.

The current replay and extension test evidence is recorded in [standalone-verification.md](standalone-verification.md). Saved-image recognition and isolated native-input tests do not establish live Tencent acceptance.

## Decision

Use Jev for small visual decisions inside a workflow controlled by code. Keep rotation search, image geometry, coordinates, ordering, deadlines, input, and outcome handling in code. Jev is a structured decision API rather than a chat completion model. The extension therefore exposes it through `verification_shape_match`, not the chat model selector. This follows [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).

The most useful cookbook is [OCR confidence and bounding boxes](https://docs.typesafe.ai/cookbooks/ocr_confidence_bounding_boxes). It uses separate localization, refinement, and crop checks. Its own example shows that a page check and a crop check catch different errors. Those checks are useful evidence; they are not statistically independent votes.

Our real API tests found that direct Box coordinates were less reliable than choosing exact candidate crops. The implementation uses a grid to add search candidates, local image processing to determine their boxes, a closed-set Choice to select a candidate, and a separate match check against a confusing alternative.

## Implemented flow

```text
Active tab + Tencent frame + current reference order
                         |
             Capture and calibrate screenshot
                         |
        2 x 2 overlapping tiles + reference crops
                         |
              Jev region Choice per target
                         |
       Full-scene dark and neutral-pixel components
        coarse rotation search -> fine alignment
                         |
       Preserve three strongest global candidates
          + two candidates from selected region
                         |
       Batched candidate/outline Choices + candidate Nouls
                         |
         Optional aligned comparison on disagreement
                         |
               recapture + compare pixels
                                       |
                         click -> marker -> next click
                                       |
                         submit once -> inspect outcome
```

A wrong grid answer cannot remove the strongest global candidates. This is necessary: an early version cropped the image before component detection. That clipped symbols and changed the size filter, excluding some correct candidates. Grid selection now affects candidate diversity, not coordinate authority.

The grid has eight-percent overlap at internal edges. If its highest probability is below 0.7, the search region becomes the full scene. Between 0.7 and 0.9, the two leading regions are combined. These are search heuristics, not permission to click. Repeated recursive subdivision is excluded from the default path because it adds serial requests and boundary errors.

## What the docs establish

| Area | Documented behavior | Implementation consequence |
| --- | --- | --- |
| Image support | Experimental; opt-in header required | Send `TypeSafe-Danger-Zone-Images: true`; treat this as a prototype |
| Placement | Images can appear in state, instructions, and criteria | Put shared images in state and refer to named fields |
| Asset references | References match text; repeated use expands image context | Use UUID references; avoid short keys that match ordinary text |
| Box | One normalized box per question, including absent targets | Do not treat a returned box as evidence of presence |
| Small targets | Tile Choice followed by a Box or closer crop | Use coarse regions, then precise local candidates |
| Parallel questions | Questions see the same state independently | Separate stages when later inputs depend on earlier answers |
| Choice | Picks an option even when none fits | Check the selected crop separately |
| Confidence | Choice confidence derives from the same probability distribution | Do not count confidence and top probability as two checks |
| Numeric precision | Math, counting, and indirect reasoning are weak spots | Compute coordinates, counts, rotation, and ordering locally |
| SDK retries | Default retries can exceed a single request timeout | Use explicit fetch with no retries and a shared deadline |

Sources: [Images](https://docs.typesafe.ai/images), [Box](https://docs.typesafe.ai/primitives/box), [State](https://docs.typesafe.ai/concepts/state), [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out), [Companion Noul](https://docs.typesafe.ai/patterns/companion-noul), [Confidence](https://docs.typesafe.ai/confidence), [Model jaggedness](https://docs.typesafe.ai/model-jaggedness), and the [SDK source at v0.7.0](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.7.0/src/types.ts).

### Image preparation and coordinate ownership

Each uploaded PNG is a square between 280 and 1568 pixels on each side. Crops preserve aspect ratio and use white padding. The API rejects images below its size limits rather than resizing them. Multipart sends bytes directly and avoids base64 expansion. Only reference, tile, and candidate crops are uploaded; the surrounding page is excluded. See [image limits and preparation](https://docs.typesafe.ai/images#limits).

All candidate boxes stay in original screenshot pixels. The tool converts their centers to viewport CSS pixels using a uniform scale from screenshot width divided by viewport width. A cropped screenshot height does not stretch Y coordinates. Resizing images for Jev does not change these coordinates. Frame-local boxes are first mapped through the measured iframe rectangle.

If Box is revisited, its fractions must be inverted through both resizing and letterboxing before mapping to the original crop. For source crop `(sx, sy, sw, sh)`, model canvas side `S`, content scale `a`, and padding `(px, py)`:

```text
source_x = sx + (box_fraction_x * S - px) / a
source_y = sy + (box_fraction_y * S - py) / a
```

Reject non-finite or reversed edges and boxes outside the content. A Box confidence threshold cannot be copied from documentation examples: the Box docs explicitly provide no recommended threshold. See [Box coordinates and confidence](https://docs.typesafe.ai/primitives/box).

### Local contrast and rotation processing

Two masks propose candidates: luminance at most 60, and the same threshold with RGB channel spread at most 15. The second mask removes colored dark background details, including the kitten eye merged with the black `4`. Both masks are retained because a neutral-only filter can fragment other shapes.

Connected components include nearby component pairs for disconnected icons. The legacy gated diagnostic search uses a coarse 18-angle pass and keeps 12 proposals per mask for a fine 72-angle, five-scale search. Default completion uses the bounded 24-pixel, 12/18-angle search described above. Fine alignment also checks small translations. Candidate crops preserve internal strokes. These similarity values are not probabilities, and partial shapes can score highly.

A neutral mask improved the difficult `4` from about 0.884 to 0.980 in the saved image. This is a single observed regression, not validation for general obfuscation, transparent overlays, missing strokes, or unseen icon families.

### Request and failure handling

The authenticated model-list request succeeded. Image requests using `jev-latest` returned `model: jev-1.14.0`. The SDK guide still mentions `jev-preview` for Box, while the model page says both aliases currently resolve to 1.14. Log the response model instead of inferring it from the alias. See [Models](https://docs.typesafe.ai/models), [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript), and [System One API](https://docs.typesafe.ai/api/system-one).

The client sends multipart `request` JSON first, then named PNG parts. Every asset is referenced. It validates answer types, known option names, finite probabilities, distribution totals, and consistency between the selected option and its probability. It rejects redirects and non-HTTPS API origins.

There are at most three concurrent per-target requests. Each call can use the remaining shared five-minute budget after reserving 1.5 seconds for input. The earlier independent 2.5-second cutoff was removed because it could abort a valid response while several seconds remained. Request and attempt timers are cleared after work ends. Cancellation propagates to concurrent requests, and timeout stage evidence remains available. HTTP 429, overload, authentication failure, malformed output, or timeout ends the attempt. There is no silent retry or automatic fallback after a remote failure. The provider documents retries for normal applications; that default does not fit an expiring challenge. See [Request rules and errors](https://docs.typesafe.ai/api/errors).

## Measurements

Tests used six original screenshots, three targets each. One older cache path, `13089.png`, now holds a different image and was excluded. Evidence pins current input hashes and geometry in `typesafe-verification-evidence.json`. The older binary fixture remains a separate local regression.

| Screenshot | Recognition time, ms | First-ranked candidates correct | Targets clearing all gates | Full sequence eligible |
| --- | ---: | ---: | ---: | --- |
| 2138 | 6037 | 3/3 | 2/3 | no |
| 37313 | 4466 | 3/3 | 3/3 | yes |
| 7324 | 5835 | 3/3 | 2/3 | no |
| 30230 | 5964 | 3/3 | 2/3 | no |
| 85369 | 4750 | 3/3 | 2/3 | no |
| 68280 | 6421 | 3/3 | 2/3 | no |

These are recognition times through the real API via an isolated browser test bridge. They exclude real Tencent input, expiry, and acceptance. They are six measurements, not a latency percentile or service guarantee. Requests used the same development examples used to shape the pipeline; this is not an independent test set.

Additional experiments:

- One direct shared-scene Box request found the three kitten-image targets in 827 ms, with reported Box confidence 0.42 to 0.63.
- The naive tile-then-Box pipeline produced several offsets of 49 to 161 pixels on other examples. Subsequent crop checks rejected several of those mistakes.
- Candidate Choice selected the observed correct crop for all 18 targets in a separate real-API run. The companion question over all candidates often had low probabilities even when Choice was correct.
- Separate crop-pair checks gave correct-match probabilities from 0.38 to 0.98. Normalizing mask rotation did not consistently improve them. It is not the default model view.
- The current kitten result still abstains: the cat crop's match probability was 0.68. The first target's contrast problem is fixed, but the full challenge is not eligible for automatic input in that measured run.

The conservative gates accepted 13 of 18 individual targets and one of six full sequences. A repeat run selected the correct candidate for all 18 targets again, but accepted two full sequences rather than one. Per-target checks changed enough to affect eligibility. That run overlapped local checks during its first portion and is repeatability evidence rather than a clean timing comparison. No incorrect target passed in these small runs. That does not establish the false-accept rate. Increasing completion by weakening thresholds requires a separate labeled test set, especially missing-target and near-duplicate cases.

## Acceptance and state transitions

The gate combines local shape score and separation, the selected Choice probability and runner-up, the selected crop's Noul, and the alternative crop's Noul. Strong local matches use a less strict model-match floor than ambiguous local matches. The gates are explicit in `acceptMatch` and remain provisional; they are not calibrated product guarantees.

A model answer never dispatches input directly. Before input, the tool recaptures and compares the scene and reference pixels, checks the tab and geometry, and inspects the challenge identity and marker count. Each click records `input_started`, `input_dispatched`, and an observed `acknowledged` transition. A dispatch failure can leave an uncertain selection and must not trigger another click. Submission has its own dispatch and result checks.

Success, explicit failure, changed challenge, and unresolved outcome remain separate states. A changed challenge invalidates all previous matches. No automatic refresh, new challenge attempt, or repeated click is part of this workflow.

## Build and use

The ignored local `.env` supplies `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, and `TYPESAFE_DEFAULT_MODEL`. `.env.example` has no credential. The build copies private configuration to ignored `dist-chrome/typesafe.local.json`, outside bundles and source maps. E2E builds disable it. This local distribution contains the credential and is a private artifact. No commit or release was made.

Packaging validation: `./check.sh` passed, all 31 focused tests passed, and the production distribution loaded in an isolated Chromium profile. Its own authenticated request to `/v1/models` returned HTTP 200 in 359 ms. The mocked Jev pipeline plus real native input completed in 3243 ms. Neither check proves live Tencent completion. The credential scan found no key in tracked/nonignored files, JavaScript bundles, or source maps.

Reload the existing unpacked extension from `dist-chrome`, then start a new chat so the tool definition is current. Suggested prompt:

> Complete the current verification and continue the original task. Use verification_shape_match with no extra parameters. Follow its nextAction if the result needs inspection.

To rerun the saved-image API benchmark explicitly:

```sh
node --env-file=.env scripts/benchmark-verification.mjs
```

The script checks hashes before using saved geometry, sends crops to Typesafe, and writes `/tmp/sitegeist-typesafe-benchmark.json`. It makes paid API requests. Run the local regression and isolated browser tests separately; mocked browser success does not substitute for a real provider or live Tencent result.

## Regression: chart strokes competing with `1` (45818)

The user supplied a live tool log that abstained before input in 5213 ms. The correct isolated `1` ranked first, but a disconnected bar inside the chart received a 0.979 shape score. Jev gave the correct candidate probability 0.55 and the alternative match probability 0.85. No click was acknowledged or submission attempted in that reported run.

Two proposal defects were present. First, connected components enclosed by another icon component were being treated as standalone symbols. Second, the contrast mask produced partial copies of objects that were complete in the dark mask. These were separate Choice options and confusing alternatives.

The parser now suppresses strictly enclosed component details. The combined proposal list also suppresses a contained partial box when another proposal encloses it and has at least 1.5 times its area. Slight edge trims remain separate mask views; detached marks outside an enclosure remain eligible for grouping. This is a proposal heuristic, with regression coverage, not a general proof that every nested object is invalid.

A partial fix passed `1` and `8` but still abstained on `5` because a second partial chart was retained from the contrast mask. After consolidating both masks, the real-API screenshot replay selected all three observed targets and cleared every existing acceptance gate in 4793 ms:

| Reference | Choice probability | Crop match | Alternative match | Accepted |
| --- | ---: | ---: | ---: | --- |
| 1 | 1.00 | 0.93 | 0.02 | yes |
| 8 | 1.00 | 0.88 | 0.04 | yes |
| 5 | 1.00 | 0.94 | 0.04 | yes |

Acceptance thresholds were unchanged. A proposed cross-reference assignment override was discarded after inspection showed that the remaining alternative was another chart fragment. No such override is included in the build.

This replay used the real API against a saved screenshot. It sent no input to Tencent and does not establish live completion. The screenshot hash, geometry, reported failure, partial-fix output, and final replay are recorded under `regressions` in the evidence file. The benchmark accepts an optional fourth argument to select one fixture ID:

```sh
node --env-file=.env scripts/benchmark-verification.mjs /Users/zeus/Library/Caches/Clop/images /tmp/chart-regression.json 45818
```

The agent prompt also distinguishes a recognition limit from input support. When no input has been sent, it asks about the ambiguous target. User-assisted input still requires fresh geometry and marker checks; changed challenges invalidate prior coordinates.

## Result instructions

Every successful tool return now includes `nextAction` in both agent-visible JSON and structured details. Accepted analysis returns ordered targets and a `click_and_verify` instruction: refresh the visual evidence, click in order, confirm each marker, submit once, and inspect the outcome. Recognition that stopped before input returns `inspect_matches`, directing the agent to try fresh visual resolution before asking a focused question. Pending input returns `inspect_markers`; a pending submission returns `verify_submission`. Success directs continuation, while a changed or failed challenge never returns stale click targets. These instructions do not dispatch input themselves or authorize duplicate clicks.

## What remains unproved

A production claim needs independent screenshots, repeat runs across model versions, absent-target and near-duplicate tests, occlusion and contrast sweeps, multiple zoom/DPR settings, rate-limit and network-tail behavior, expiry behavior, and live Tencent outcomes. Measure false accepts and full-sequence completion, not just top-candidate accuracy. A grid must improve search without becoming an exclusion rule. A pipeline that safely abstains on five of six examples has not met a general unattended-solving objective.

Other reviewed patterns: [reading scanned documents](https://docs.typesafe.ai/cookbooks/reading_scanned_documents), [structured questions](https://docs.typesafe.ai/primitives/advanced), [Choice](https://docs.typesafe.ai/primitives/choice), [Noul](https://docs.typesafe.ai/primitives/noul), and [routing by confidence](https://docs.typesafe.ai/patterns/confidence-routing).
