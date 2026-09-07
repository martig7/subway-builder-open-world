# Incremental hourly finance: Japan verification

Verified on 2026-09-07 with `local.japan-open-world`, built from
`prototype/japan/mod`. After the user saved and closed the restarted game,
Subway Builder was relaunched with a local debugger on port 9222. Native Resume
loaded `[Auto] 2026-09-07_16-34-30`, Osaka (`JP_PREF_27`), with the same regional
network: 316 stations, 53 routes, 2,294 tracks and 28,709 loaded pop groups.

## Changes

The production finance adapter retains one defensive opening copy of each
native history. Backfill helpers accept ownership of those detached copies,
while their default public behavior still copies inputs. Cached simulation and
inactive-tile revenue callers request receipt/balance results without copying
history back to a caller that does not use it. Existing callers that need the
history retain the default result shape. Native financial actions, exact
partial-hour accounting and durable receipt-based duplicate protection remain.

A disposable `NativeCommuteIndex` is shared by cached, inactive and cross-tile
postings. It indexes IDs with counts and groups record references by ending
hour. Existing duplicate IDs and insertion order are preserved. Expiration
visits expired buckets and the partial boundary bucket instead of filtering
all records on every cached flush. Each new record and its route attribution
are cloned once. One native array publication handles insertion and expiration.
There is still an array of all retained records for native charts; publishing
that array can require a linear reference copy, but repeated field scans and
index reconstruction are avoided.

The index trusts the native setter's immutable-record contract. A native array
replacement, same-array append/length change, game-session change or clock
rewind rebuilds it. Failed preparation/publication forces synchronization with
the actual native array on the next operation. No index is persisted as save
or accounting authority. Live demand assignments and their route paths are
unaffected.

## Measurements

The harness timed ten seconds of running cached Ultra mode per capture and
classified awaited ticks by whether they crossed a game-hour boundary.
It restored the native tick and `structuredClone` functions afterward.
The native clock was preserved, so these are live observations over different
hours and commute populations, not an identical-input replay. Both builds use
the existing 10x Ultra multiplier.

| Metric | Before | First optimized | Repeat | Final installed |
| --- | ---: | ---: | ---: | ---: |
| Hour boundaries sampled | 12 | 11 | 10 | 10 |
| Median hourly tick | 169.4 ms | 108.8 ms | 120.4 ms | 131.8 ms |
| Maximum hourly tick | 346.3 ms | 402.4 ms | 245.8 ms | 284.1 ms |
| Dashboard + route history copies | 148 | 66 | 62 | 62 |
| History copies per sampled hour | 12.3 | 6.0 | 6.2 | 6.2 |
| Retained commute records at end | 36,462 | 32,066 | 33,569 | 31,509 |

Observed median hourly time fell by **22–36%**, with about **half as many
history copies per hour**. The final installed capture measured 131.8 ms,
22% below baseline. The worst frame was not consistently improved: one
optimized capture was worse than baseline. This work reduces two measured
costs; it does not eliminate hourly stalls or native autosave pauses. Remaining
World settlement, native UI work and the final record-array publication still
share the main thread.

The final build differs from the initial optimized build only by preserving
an empty `stationRoutes` array on cross-tile records without route attribution,
plus a regression test for that compatibility behavior. Both builds and all
captures are identified in the accompanying JSON.

## Verification and delivery

- **612 platform tests and 4 Japan tests passed.** Diff whitespace checks passed.
- New tests cover exactly two opening history copies, no unused return copy,
  no repeated ID reads on indexed updates, exact partial-hour expiration,
  native array replacement/append, session change, rewind, duplicate IDs,
  out-of-order/unknown end times, failed publication and interleaved cross-tile
  and cached postings.
- Final live smoke preserved frozen trains in cached mode. Native simulation
  resumed and moved trains. Synchronous save generation succeeded; repeating
  it did not post money twice. All loaded assignments conserved pop mass,
  and 4,011 transit directions retained route segments. Autosave error was null;
  no window error or unhandled-rejection events were captured.
- Native cached wrapper marker: `open-world-cached-simulation-v3`; adapter
  marker: `native-hourly-finance-v1`. Live runtime generation 3, render guard 17.
- Both built and installed bundle SHA-256:
  `0549a979feae4c2a9f8b91b5faa7651f12380ea2b3994b87f3f6c7c453cee152`.
  Both timestamps: `2026-09-07T20:56:53.0310081Z`.
- Installed mod directory: `%APPDATA%/metro-maker4/mods/japan-open-world`.
  PMTiles returned HTTP 200 with `native-pmtiles-directory-v4`.
- Game left paused, cached mode enabled, debugger available. The live clock
  advanced during tests; no earlier save was restored over current progress.

[Measurements and installation proof](hourly-finance-japan-benchmark.json).
Local repro command: `node recovery/cdp-eval.mjs .analysis/hourly-live-benchmark.js`.
The harness, complete raw tick captures and temporary probes are kept in
Git-ignored `.analysis`; temporary live instrumentation was removed.
