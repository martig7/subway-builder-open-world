# Cached-mode map responsiveness: Japan verification

Verified on 2026-09-07 with `local.japan-open-world`, built from
`prototype/japan/mod`, on the live **Japan Regional 316 - Tokyo to Kobe** save:
316 stations, 53 routes, 2,294 tracks and 28,709 loaded native pop groups.

The simulation cache was active, but clock updates still rebuilt track/train
geometry and hidden road buffers. Hourly settlement also rescanned the commute
ledger for each of 47 prefectures and cloned unchanged revenue profiles.

The fix preserves clipped track/carriage data across equivalent native frames,
checks detached snapshots for in-place geometry/style edits, and retains hidden
layers until they become visible. The latest canonical input remains available
for reveal. Road layer reuse respects native color triggers, zoom opacity and
source changes. The movement guard replaces previous generations on reload.
Hourly World advancement now projects all prefectures in one ledger pass.
Unchanged immutable tile profiles skip repeat copying. Cached active accounting
publishes at game-hour boundaries; saving, disabling or recalculating flushes
all remaining partial-hour time. Wallet/history displays can consequently lag
by up to one game hour while running.

## Live measurements

The same scripted camera animation ran twice per build: 3 seconds of panning
and zooming from zoom 10 to 10.3 near Osaka, each followed by a paused run.
The live clock was preserved, rather than restoring an earlier save. Both
builds used the same intentional 10x Ultra clock multiplier.

| Running cached mode | Before | Delivered build |
| --- | ---: | ---: |
| Median frame interval, run 1 | 243.4 ms | 6.7 ms |
| Median frame interval, run 2 | 243.4 ms | 6.7 ms |
| 95th percentile, run 1 | 703.4 ms | 26.7 ms |
| 95th percentile, run 2 | 413.3 ms | 23.4 ms |
| Frames over 50 ms, runs 1 / 2 | 12 / 12 | 4 / 5 |
| Simulated seconds, runs 1 / 2 | 3,120 / 3,120 | 14,400 / 12,720 |

Median frame intervals improved about **36x**; game-time throughput during
camera motion improved about **4.7x**. The delivered build passed the harness's
95th-percentile threshold of 33.4 ms in both running passes. Paused passes had
3.4 ms median and 6.7 ms 95th-percentile intervals. Across the whole harness,
spatial clipping fell from 5,709 ms to 190 ms. These are observed live-session
measurements, not a promise of fixed FPS: initial map loading, native autosaves,
hourly settlement and garbage collection can still produce occasional stalls.
The first baseline paused pass included a large transient stall; running-mode
comparisons above use both running passes, not that paused outlier.

## Delivery and correctness

- Platform: **605 passed**, Japan consumer: **4 passed**, diff whitespace check clean.
- Regression tests cover buffer identity, recreated and in-place edits, hidden
  updates/reveal, native visibility, road colors/opacity, tiled road sources,
  wrapper-generation replacement, profile invalidation and exact partial-hour
  settlement on synchronous saves.
- Executing marker: `open-world-cached-simulation-v2`; movement guard **17**;
  live runtime generation **6**.
- Built and installed bundle SHA-256:
  `3b6dc8d86e1fb3b7784d4f978d94521fed243fd2495a4739c69780816d704651`.
  Both timestamps: `2026-09-07T20:30:46.1346120Z`.
- Installed directory: `%APPDATA%/metro-maker4/mods/japan-open-world`.
  PMTiles health returned HTTP 200, `native-pmtiles-directory-v4`.
- Live smoke: train state stayed frozen under cached ticks; synchronous save
  generation succeeded; repeated saves did not post twice; zero invalid mode
  assignments across loaded pops and 4,011 transit directions retained paths.
  Native simulation resumed and moved trains through 136 game seconds, then
  cached mode recalculated successfully. Autosave error was null and no new
  window errors or unhandled rejections were captured.
- Original regional `.metro` file SHA-256 remained
  `846b18707c4aa3f82a3f5b060f8637cef733b57dd12c187b41cdab18fb5415df`.
  The live clock advanced during testing; original disk save was not overwritten.
  Cached mode is enabled and the game is paused, preserving the user's state
  before installation.

Raw measurements, installation proof and smoke results are in
[cached-map-responsiveness-japan-benchmark.json](cached-map-responsiveness-japan-benchmark.json).
The agent-runnable local harness is `.analysis/cached-responsive-benchmark.js`,
invoked with `node recovery/cdp-eval.mjs .analysis/cached-responsive-benchmark.js`.
It restores the camera and pause state after each capture. CPU profiles and
throwaway probes remain in Git-ignored `.analysis`; temporary live handlers were removed.
