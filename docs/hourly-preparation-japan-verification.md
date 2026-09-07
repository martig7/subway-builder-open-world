# Hourly worker and browser preparation — Japan

Verified September 7, 2026 on `local.japan-open-world`, built and installed from
`prototype/japan/mod`. The live regional Japan save had 316 stations, 53 routes,
2,294 tracks and 28,709 native populations. Baseline runtime source was commit
`25bfe5fdaa666718e3dc933fa19f943090fe7e41`.

## Changes

A resident worker receives the cached daily revenue and expense profile once
per revision and calculates the next exact posting interval. Prediction includes
the current speed's hour-boundary overshoot. Changing speed, fare, network,
session or settled interval replaces obsolete preparation. Only one interval is
retained. Worker errors or timeouts use cancellable browser preparation; an
unavailable or stale result leaves synchronous settlement available.

Native preparation copies history entries, route histories and incoming commute
records between yield points, canonicalizes routes, merges the disposable
commute index, and prepares dashboard backfills. It does not publish records or
change native money. Before committing, it checks the session, clock regression,
wallet, route identities, history references/current totals, receipt collection,
and native commute array. Invalid preparation is recomputed synchronously.
The final native actions and receipt publication remain synchronous. A save
settles precisely the elapsed interval even while future preparation is pending.

Remaining cached World settlement stages have browser yield checkpoints.
Preparation targets a 4 ms budget between units; it uses `scheduler.yield()`
when available and real timer tasks otherwise. Individual operations are still
indivisible: the final captures recorded a maximum preparation slice of 17.4 ms,
so this is not a hard 4 ms upper bound. Caches remain disposable and are not
save or accounting authority. Native demand assignments and route paths remain
available to the game's demand view.

## Live measurements

The recorder in `recovery/japan-hourly-frame-benchmark.js` runs cached Ultra for
20 seconds, times awaited ticks, observes browser long tasks (at least 50 ms),
and records animation frames. It restores native functions, pause and speed.
It skips the initial animation-frame gap. Hourly long tasks are classified by
temporal overlap with a tick crossing an hour boundary. This is a responsiveness
measurement, not a CPU profile attributing every task to one function.

The baseline below is the clean repeat capture, without a concurrent build.
Both final captures use the same installed bundle and native scheduler yielding.
The clock progressed normally, so these sample different hours and demand
populations on the same network, rather than replaying identical inputs.

| Metric | Previous commit | Final build | Final repeat |
| --- | ---: | ---: | ---: |
| Hour boundaries sampled | 22 | 22 | 24 |
| Median awaited hourly update | 118.4 ms | 109.8 ms | 104.4 ms |
| Median hourly long task | 118 ms | 77 ms | 76 ms |
| 95th percentile hourly long task | 314 ms | 95 ms | 105 ms |
| Maximum hourly long task | 467 ms | 96 ms | 148 ms |
| Cached hourly preparation hits | — | 22 | 24 |
| Worker fallbacks | — | 0 | 0 |

Median hourly update time decreased **7–12%** (about **1.08–1.13×** faster).
Median hourly blocking decreased **35–36%**, and the 95th percentile decreased
**67–70%**. Across the two final captures, all 46 hourly intervals used prepared
postings. One additional partial settlement used the synchronous path.

An earlier timer-based implementation reduced blocking but increased median
awaited hourly time to 136–138 ms. Using the live browser's native scheduler
removed that scheduling overhead; the final numbers above supersede that build.
Large outliers remain elsewhere: a final capture included a non-hourly long task
of 1.59 seconds and an animation-frame gap of 2.08 seconds. These optimizations
do not eliminate all game pauses.

## Verification and installed state

- All **621 platform/runtime tests** and **4 Japan consumer tests** pass.
- Regression coverage includes exact midnight/partial intervals, speed changes,
  save while preparation is pending, stale native accounting/session/array,
  duplicate receipts, worker failure/timeout/cancellation, and replacing the
  previous v3 wrapper and patch object.
- Live checks: synchronous repeated saves without duplicate money postings;
  zero invalid population assignments; 4,011 transit directions with route paths;
  frozen fleet in cached mode; fleet movement and 168 seconds of native time
  after disabling it; no captured runtime errors or autosave errors.
- The final built and installed bundle SHA-256 is
  `6759c486af181ef668764dae14d4e8a2d54f52a98ecbff1488bd5ed378f491ed`.
  Both timestamps are `2026-09-07T21:36:03.5619355Z`.
- Both bundles contain `open-world-cached-simulation-v4`,
  `native-hourly-finance-v2`, `cachedSimulationPostingSteps`, `createFrameBudget`
  and `globalThis.scheduler.yield`. The live renderer ran generation 8 and v4;
  fresh counters demonstrated worker requests, preparation and reuse.
- PMTiles health returned HTTP 200 and `native-pmtiles-directory-v4`.
- Map diagnostics were reset for the final compatibility check and disabled
  afterward. The game was left paused, cached mode enabled, at the existing
  camera position. The original regional save was not overwritten by the
  in-memory save checks; normal game autosaving remained active.

Compact captures and installation evidence are in
`docs/hourly-preparation-japan-verification.json`.
