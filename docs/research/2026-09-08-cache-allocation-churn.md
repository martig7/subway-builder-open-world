# Cache allocation churn reduction

Implemented and measured on 2026-09-08 in the Japan consumer,
`local.japan-open-world`, built from `prototype/japan/mod`.

## Changes

- Track snapshot comparison traverses own properties without creating recursive
  `Object.keys()` arrays and `.every()` callbacks. It still detects in-place
  geometry edits and property additions/removals. Guard generation 22 replaces
  retained generation 21 wrappers on mod reload.
- Hourly backlog updates sum the two departure queues directly. They no longer
  construct full commute projections and duplicate gateway maps for every tile.
  Consumers requiring full projections retain the existing implementation.

## Live measurements

Two passive allocation samples included objects collected by both minor and
major GC, using a 262,144-byte sampling interval. These are estimated allocation
rates, not retained cache sizes. Each capture lasted approximately 20 seconds.

Both captures used Osaka (`JP_PREF_27`), the same stationary camera
(135.22923561644257, 34.744616664796396; zoom 10.112447351102523), unpaused,
with cached Ultra enabled and ready. No cached recalculation occurred during
either capture. The live network retained 316 stations and 53 routes.

| Measurement | Before | After |
| --- | ---: | ---: |
| Total allocation, MiB/s | 465.705 | 299.025 |
| Track comparison, MiB/s | 154.633 | 5.249 |
| Full commute projections, MiB/s | 51.121 | 0 sampled |
| Backlog-only projection, MiB/s | 0 | 0.038 |
| Other allocation, MiB/s | 259.951 | 293.738 |
| Completed cached ticks | 326 | 369 |
| Total allocation per cached tick, MiB | 28.571 | 16.211 |

Total allocation fell 35.8%, or 43.3% per completed cached tick. The two targeted
paths together fell 97.4%. Cached tick throughput rose approximately 13.2%; this
passive observation is not a controlled FPS benchmark. The captures were at
different simulation times, separated by a mod reload. No claim about maximum
GC pause reduction follows from these allocation samples alone.

Reloading the mod reset cached Ultra to disabled. That initial post-reload
capture was excluded; Ultra was restored and ready before the reported capture.

Raw local evidence is Git-ignored under `.analysis/`:
`churn-fix-before.json`, `churn-fix-after-ultra.json`, and
`churn-fix-comparison.json`.

## Verification

- Shared platform and regression-fixture suite: 666 passed.
- Japan consumer behavioral suite: 5 passed.
- Allocation regression: the original comparison allocated approximately
  147 MiB for 250 comparisons of 500 unchanged features. The replacement passed
  the same test's allocation budget of less than 1 MiB.
- Tests cover in-place edits, property replacement/deletion, inherited
  properties, typed arrays, previous-generation wrapper replacement, and backlog
  equivalence across departure/arrival hours and constrained gateway capacity.
- Built and installed Japan bundle SHA-256:
  `63D03A57D3223B733266E9E4D514CB01F619E365DA01E1ED05B5AB499D5D8B7D`.
  Both copies contain `projectCommuteBacklogs` and guard generation 22.
- Installed bundle: 6,241,789 bytes, timestamp 2026-09-08 06:21:33 UTC.
- Reloaded runtime reports guard generation 22; diagnostics were reset.
- PMTiles port 8799 health returned HTTP 200 with
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
