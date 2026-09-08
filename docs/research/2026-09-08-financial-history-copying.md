# Financial history copying optimization

Implemented and measured on the live Japan save on 2026-09-08. The previous
motion trace identified native history cloning and copying the clone into the
World as recurring contributors to running-mode frame gaps.

## Change and ownership

Routine revenue-only World observations and cross-tile fare receipts now request
current native totals without returning financial history. They no longer
maintain a duplicate native history in `world.financialHistory`. Full diagnostic
reads, legacy accounting, and default adapter callers keep the existing detached
history contract. Native saves and native financial state retain the full ledger.

Background posting preparation uses `copy: 'on-write'` in the shared backfill
functions. It replaces changed containers and rows while sharing untouched closed
rows. Current-hour updates preserve the closed-history array itself, avoiding
whole-history cloning, indexing, sorting, and row reconstruction. Closed rows are
still scanned to validate ordering and numeric balances before that fast path;
this is not an unsafe identity cache. Delayed postings still adjust subsequent
balances, and malformed historical inputs retain normalization behavior.

The native ledger remains the sole authority. Preparation publishes nothing
until commit; existing validity stamps reject competing native updates, clock
rewinds, session changes, and receipt changes. Default backfill callers continue
to receive deep copies. No history retention cap or accounting truncation was
introduced.

## Verification

The initial regression run failed on copying closed row references and on
unnecessary history reads by current-total-only callers. The completed suite
passes **671 platform/fixture tests plus 5 Japan behavioral tests**.

Coverage includes frozen input ledgers; current-hour updates; late postings;
rollover and gaps; duplicate receipts; clock rewind; sandbox expense semantics;
legacy malformed balances; in-place native accounting during preparation;
handoff of complete native finance; and full diagnostic read isolation. A
10,000-row adapter test verifies that untouched row payloads are not read/cloned.

An isolated benchmark runs the previous adapter/model from commit `44416cb`
against the new code. The fixture has 10,000 closed financial rows, 53 routes,
and 240 closed rows per route. Each iteration reads current globals, performs the
prior World defensive copy if history was returned, and posts revenue/expenses.
After five warmups, 50 iterations produced:

| Metric | Before | After |
| --- | ---: | ---: |
| Mean update time | 54.489 ms | 0.140 ms |
| p95 update time | 60.464 ms | 0.209 ms |
| Maximum update time | 65.128 ms | 0.285 ms |

Both ended with wallet 100440, 10000 history rows, current revenue 550, and current
expenses 110. This isolates the copied-ledger workload; it is not a game FPS claim.
Local benchmark: `.analysis/benchmark-finance-copy.mjs` and
`.analysis/finance-copy-benchmark.json`.

## Live allocation sampling

Two 20.011-second samples on the same stationary Osaka camera, unpaused, with
cached Ultra ready and enabled. Sampling includes objects already collected by
minor and major GC, with a 262144-byte interval. No heap snapshot or forced GC.

| Metric | Before | After |
| --- | ---: | ---: |
| Completed cached ticks | 264 | 380 |
| Finance copying/posting stack allocation | 71.386 MiB/s | 12.268 MiB/s |
| Native financial dashboard allocation | 139.281 MiB/s | 205.491 MiB/s |
| Total sampled allocation | 354.267 MiB/s | 419.455 MiB/s |
| Total allocation per cached tick | 26.853 MiB | 22.089 MiB |

Finance copying/posting allocation fell **82.8% per second**, or approximately
**88.1% per cached tick**. Tick throughput increased **43.9%** in these samples.
Total allocation per second increased as more work completed; total allocation
per tick fell **17.7%**. The native financial dashboard is now the largest sampled
allocation source. The finance group also includes remaining commute receipt
copying, so its residual is not all financial-history copying.

Raw data: `.analysis/finance-churn-before.json` and
`.analysis/finance-churn-after.json`, plus their summary files.

## Live frame gaps

The same fast camera sequence from the previous report was run before and after,
without CPU profiling or tracing. Eight directional movements per phase,
300 ms animations, 550 ms between starts; zooms alternate between 8.5 and 13.
Frame gaps are measured between animation callbacks, not GPU presentations.

| Simulation | Movement | Before p95 / max, ms | After p95 / max, ms | >100 ms, before / after |
| --- | --- | ---: | ---: | ---: |
| Paused | Pan | 12.6 / 44.6 | 9.8 / 25.3 | 0 / 0 |
| Paused | Zoom | 55.6 / 211.8 | 77.3 / 304.2 | 3 / 5 |
| Paused | Pan + zoom | 46.3 / 111.3 | 52.7 / 159.2 | 1 / 1 |
| Running | Pan | 133.9 / 235.2 | 31.1 / 177.3 | 26 / 7 |
| Running | Zoom | 212.8 / 262.8 | 144.9 / 183.8 | 30 / 17 |
| Running | Pan + zoom | 174.6 / 360.5 | 127.6 / 235.4 | 26 / 13 |

The unpaused p95 gaps improved approximately 77%, 32%, and 27%, respectively.
These are one paired live sequence, separated by a mod reload and advancing
simulation time. Paused zoom results vary and worsened in this pair, so the
results do not establish a universal zoom improvement or eliminate all stalls.
The 304 ms paused zoom outlier was not CPU-profiled and has no assigned cause.

Raw frame data: `.analysis/finance-copy-before.json` and
`.analysis/finance-copy-after.json`. Both captures reported no renderer exceptions
or visibility changes. Camera and pause state were restored afterward.

## Deployed consumer

- Manifest: `local.japan-open-world`; built from `prototype/japan/mod`.
- Installed directory: `%APPDATA%/metro-maker4/mods/japan-open-world`.
- Bundle SHA-256:
  `AD2AE9A57E6040644375FF21615DE6F4AB0794B3E5B69B00BEA7F22D55BDD102`.
- Built and installed copies: 6243062 bytes, 2026-09-08 13:26:51 UTC.
- Both copies contain `native-finance-copy-on-write-v1`. The live cached-mode
  preparation diagnostics report this marker after reload, generation 5.
- PMTiles port 8799: HTTP 200,
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
- Reload initialization took approximately 35 seconds. An early Ultra enable
  attempt returned “Wait for the World to finish loading.” It was reset after
  initialization; both reported after-captures began with Ultra ready. Diagnostics
  were reset before capture.
- Osaka `JP_PREF_27`: 316 stations, 53 routes, 28709 assigned pops; cached daily
  ridership 286819 and daily revenue 261722337.5 remained the same.
- Restored camera: [135.22923561644257, 34.744616664796396], zoom
  10.112447351102523, bearing/pitch 0; unpaused, cached Ultra enabled.
