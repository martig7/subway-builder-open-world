# Midnight commute refresh — September 12, 2026

Rail/service and fare changes now queue ultra-high-speed commute assignments for
the shared midnight batch. Existing assignments remain usable through the day.
The active-tile calculation and cross-network recalculation start concurrently
in their existing local workers. The clock waits for both jobs, including when
one fails early. Failed/stale work and edits received during a batch stay queued.

Native and cached day notifications use the elapsed simulation day as their
common key. A duplicate notification joins a running batch; a late duplicate
cannot consume edits reserved for the following midnight. The cached clock stops
exactly at midnight so old and new finance rates do not overlap across a tick.

Initial enabling and replacement of the save, Tile View, or demand set still
require an immediate calculation. Operating costs and train billing anchors
update at edit time without rerouting commuters. The save contract and finance
ownership described in [ADR 0004](adr/0004-cached-simulation-owns-ticks-only-while-enabled.md)
remain intact.

## Automated verification

The platform suite passes 830/830 tests and the Japan consumer suite passes 7/7.
New behavioral coverage checks daytime reuse, paused edit bursts, one refresh at
midnight, immediate preparation on enable, demand replacement, edits during an
in-flight calculation, exact expense settlement at edit time, and replacement
of the previous generation's tick/save wrappers.

The scheduler tests hold one job open to prove both jobs start independently and
that duplicate hooks wait for both. They cover worker failure, incomplete finance
profiles, late edits, and late duplicate day notifications. The game-entry
integration test invokes the schedule hook and cached tick together, including
the native UI's one-based day label for the same elapsed-day boundary.

## Live verification

JavaScript through the already-open game's debugging connection invoked the real
service-change callback three times while paused. This produced no demand-worker
calls and preserved the published demand object. The pending midnight flag and
shared dirty reasons were set. Invoking the midnight coordinator twice returned
the same batch promise and produced exactly one new active-tile calculation.

In the successful final-build run, the active worker ran from 0.114 to 21.364
seconds after the batch started. The cross-network worker ran from 7.765 to
15.926 seconds, overlapping the active worker. The complete batch took 21.612
seconds and ended with no pending dirty reasons, 34,027 assigned cohorts, and
the expected daily revenue of 11,193,896,266.75.

These were synthetic service notifications without editing the player's network;
all 47 native tile finance profiles were reusable. The check demonstrates
scheduling and actual worker overlap, not the duration of a full rail-network
rebuild. Exact midnight tick/finance behavior is covered by the integration tests.
The simulation clock remained at 220,790,637 seconds, with 678 stations, 78 routes,
4,382 tracks and 610 trains. Temporary method instrumentation was restored, and
ultra-high-speed mode was left enabled with the original paused setting.

One repeat after multiple hot reloads ended with the debugging error `Target
crashed`. The game recovered automatically to the same save session, clock and
network counts. The same final-build check then passed on the fresh renderer
(runtime generation 1). The crash cause was not established; this is a limitation
of the verification, not a claim that renderer stability was fixed. Local raw
captures remain in the ignored `.analysis/midnight-refresh-*` files.

## Installed consumer

- Manifest: `local.japan-open-world`.
- Consumer build directory: `prototype/japan/mod`.
- Installed directory: `%APPDATA%/metro-maker4/mods/local.japan-open-world`.
- Scheduler marker: `midnight-commute-refresh-v2`.
- Tick/save wrapper marker: `open-world-cached-simulation-v8`.
- Built and installed bundle SHA-256:
  `B4316580F9DEA9470457325D58413EBE81159909975B363DF1F271671138DFBF`.
- Both bundle timestamps: `2026-09-12T19:41:40.1317892Z`.
- Hot reload reported generation 4 and both current markers; after automatic
  renderer recovery the final successful run reported generation 1 with the same
  current markers.
- PMTiles health: HTTP 200, `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
