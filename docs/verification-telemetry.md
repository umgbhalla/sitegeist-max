# Verification recordings and calibration samples

Both extensions record every `VerificationClient.verify()` call by default: completion, analysis, cancellation, setup errors, changed challenges, and unresolved outcomes. Recording stays in the extension's local IndexedDB. Each extension has its own history. No telemetry upload endpoint is used.

## Collect samples

1. Reload both extensions after rebuilding. Current logs identify policy `jev-2026-11-08.4`.
2. Run verification normally. No recording parameter is needed.
3. In the standalone control, open **Attempt details**, select the observed result, and optionally add a calibration note. **Save observed result** records your label separately from the automatic outcome.
4. Click **Export latest 20 runs** to download one dataset containing records and binary assets. **Export this run with images** exports a single run. The extension toolbar action also opens the export controls when no challenge is visible. The older **Save attempt log** link remains a small JSON status log and does not include the image dataset.

In Sitegeist, ask the agent to export the latest verification recordings. It uses `verification_runs` with `action:"export"` and `limit:20`. The same tool lists runs, labels a run, accepts ordered correct target coordinates, and clears recordings when explicitly requested. Correct targets use top-level viewport CSS pixels.

## Captured evidence

| Evidence | Contents |
| --- | --- |
| Run identity | UUID, wall-clock start/end, producer extension/version, SDK policy, five-minute budget, and separate telemetry collection time |
| Images | Frame/scene/reference crops before recognition and after interaction when still readable; dark/neutral masks; exact PNG inputs for Jev tiles, candidates, and comparison branches |
| Geometry | Screenshot and viewport sizes, uniform pixel scale, frame bounds, ordered reference bounds, grid regions, candidate boxes/rotations, model crop source/content rectangles |
| Model decisions | Logical question payloads, image-to-asset IDs, parsed answers/distributions, response model, token usage, cache status, stage timings, errors, and branch decisions |
| Iframe | Bounded DOM snapshot, instruction, marker geometry, image/canvas metadata, readable canvas pixels, computed styles, accessible stylesheet rules, resource timing entries |
| Scripts | Inline source after redaction, script references, parent verification bootstrap references, and bounded anonymous copies of public same-origin script sources after the attempt |
| Interaction | Ordered input events, actual marker acknowledgements, submission attempt, observed outcome, and next-action instructions |
| Labels | User-observed outcome, notes, optional correct ordered CSS coordinates, and label timestamp |

```text
SDK call -> local start checkpoint
  -> image/frame/model checkpoints
  -> click and result evidence
  -> final record or error record
  -> optional human label
  -> export latest 20 -> unpack -> symbol catalogue / calibration
```

Checkpoints let evidence survive an extension restart. A record still marked `running` is unfinished and may have been interrupted. It is not a success label. Storage failures are reported through the result's `telemetry` reference and do not change recognition decisions or trigger another attempt.

The recorder crops screenshots to the challenge regions. It does not retain full-page screenshots, cookies, browser storage values, request authorization headers, or the Typesafe configuration. Known SDK keys, named credential fields, and URL queries/fragments are redacted. Hidden form values and non-allowlisted HTML attributes are removed. Script snapshots are sanitized diagnostic text, not executable replay code. Anonymous script copies are fetched without cookies, redirects, or query strings and are not proof of the exact response originally executed by the frame. A missing/tainted canvas, removed frame, inaccessible stylesheet, unavailable script, or size cap is recorded as a limitation where detected.

Only the existing visual questions and image crops are sent to Typesafe. New frame/DOM/script evidence stays local. Dataset downloads start in the privileged extension context; a page does not receive the history or export bytes.

## Retention and export

The store keeps up to 50 runs or 512 MiB of accounted data. Assets are deduplicated by SHA-256 across runs and removed when no retained run references them. Each run has a 16 MiB asset budget, with at most 4 MiB per asset and a bounded event log. Public script copies are limited to three same-origin sources, 1 MB each, with a three-second collection timeout. Oversized/missing evidence is reported in `warnings`.

Exports use `sitegeist.verification.telemetry/1`: run records plus deduplicated base64 assets. The SDK checks stored asset hashes on export. Tool results use small references and summaries; binary assets stay in the export.

```ts
const runs = await client.telemetry.listRuns(20);
await client.telemetry.labelRun(runs[0].id, {
  outcome: "failure",
  notes: "The second selected icon was incorrect",
  correctTargets: [{ x: 510, y: 620 }, { x: 630, y: 700 }, { x: 590, y: 820 }],
});
const dataset = await client.telemetry.exportRuns({ limit: 20 });
```

To unpack a downloaded dataset:

```sh
node scripts/unpack-verification-telemetry.mjs /path/to/export.json /path/to/new-sample-directory
```

The script verifies SHA-256, writes PNGs under `assets/`, and writes each run under `runs/` with local asset paths. Scripts, HTML, and CSS are saved as inert `.txt` files. `index.json` lists outcomes and labels. Existing files are not overwritten.

## Building a symbol catalogue

The dataset preserves ordered reference examples, candidate/distractor crops, masks, source geometry, and observed labels. These support grouping the observed symbols across rotation, scale, and background changes, then building local templates. Exact hashes identify repeated bytes; they do not establish semantic symbol identity.

Twenty three-symbol runs can supply up to 60 reference examples, but repeated symbols reduce unique coverage. Keep a separate test set and ambiguous/distractor cases before changing selection rules. A catalogue can cover observed symbols without proving that every provider symbol has been seen. User labels remain separate from automatic acceptance so failed attempts do not silently become positive training examples.
