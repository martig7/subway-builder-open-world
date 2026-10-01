# Subway Builder 1.7.2 performance review

Research date: 2026-10-01. Scope: first-party release notes and stable modding
documentation, extraction and AST inspection of the installed 1.7.2 renderer,
commuter worker and preload, and isolated execution of their relevant functions.
Tests below measure specific operations and resource ownership; they do not
establish an in-game FPS improvement. The compiled native main entry was inspected
for channel strings only, not executed or fully decompiled.

The user selected **Japan Open World**, manifest `local.japan-open-world`, built
from `prototype/japan/mod`. Runtime corrections belong in the shared
`open-world-platform` base and must be validated through that consumer. The
installed game's separate local extraction is `.analysis/game-v1.7.2`; bundle
findings and verified delivery evidence follow below.

## Verified publication facts and release-note claims

The official changelog dates 1.7.2 to **2026-09-29**, 1.7.1 to **2026-09-13**, and
1.7.0 to **2026-08-30**. Version 1.7.1 lists only a startup black-screen fix.
Version 1.7.2's principal performance claim is that commuter decisions are
distributed across several game minutes, removing the quarter-hour spikes.
Other relevant claims are improved route path selection, fewer map interactions
interfering with annotation drawing, reliability analytics, and reliability
statistics surviving saves. It also adds four cities, menu search/context menus,
grade-conflict icons, improved capacity warnings, and small UI/cost fixes.
[Official changelog](https://www.subwaybuilder.com/changelog)

The earlier 1.7.0 release already claimed faster station-marker rendering,
movement graphics, large-map roads, track drawing, and large-city save/load.
Those are distinct from 1.7.2's decision scheduling change. No percentage,
benchmark setup, worker-count limit, memory bound, or Open World comparison is
published for 1.7.2 in the changelog.
[Official changelog](https://www.subwaybuilder.com/changelog)

## Documented public contract

The stable introduction still identifies the Modding API as **1.0.0**. This is
an API identifier, so it is insufficient to prove which game implementation
owns an undocumented wrapper seam.
[Modding introduction](https://www.subwaybuilder.com/docs)

The current constants reference still gives `COMMUTE_INTERVAL_LENGTH = 900`.
It describes 0.5-second simulation ticks, per-speed `TICKS_PER_UPDATE`, and live
`GAME_SECONDS_PER_SECOND` values. Changing batching changes CPU/render cadence;
changing the speed values changes clock throughput. The documented runtime
validation prevents invalid/fractional tick batches. No public decision-batch
configuration or worker-pool memory policy is documented here.
[Game constants](https://www.subwaybuilder.com/docs/api-reference/constants)

The game-state reference describes continuously rolling 15-minute ridership and
line revenue rates and explicitly mentions the older refresh/decay bug as fixed.
It does not attribute that fix to a particular release. It still supports both
directional mode-choice summaries, and warns that older saves can initially
return unknown directional counts. `getRouteFinancials` reports the actual
recorded ledger; `getLineMetrics` is a window-derived estimate.
[Game State API](https://www.subwaybuilder.com/docs/api-reference/game-state)

The simulation explanation still describes timetable-based range-RAPTOR and
mode-choice costs. Therefore the release note about avoiding track crossings
must not automatically be interpreted as replacement of the mod's commuter
estimator or cross-tile routing.
[Native simulation explanation](https://www.subwaybuilder.com/simulation)

## Implications for this mod — hypotheses to verify

These are repository-based inferences, not promises from the developer:

| Existing seam | What the bundle audit and tests should resolve |
| --- | --- |
| `native-commute-index.js` and native `handleIncrementGameState`/`simulateCommutes` guards | The quarter-hour demand-index assumption may no longer match the native decision schedule. Recover the exact look-ahead horizon, interval boundaries, batch ownership, and departure-time semantics before changing the index or guards. |
| `native-commute-worker-budget.js` | It only recognizes `popCommuteWorker.worker-CI81Zuw7.js`; a renamed 1.7.2 chunk will safely pass through, losing the memory bound. Verify both the new chunk name and its complete message protocol. Native staggering by itself does not prove the worker memory replicas or idle heaps were reduced. |
| `cached-simulation.js` and shared midnight refresh | Ultra-high-speed mode deliberately replaces dynamic trains/signals/capacity/reliability with estimates. Native decision staggering alone does not replace that product behavior. Preserve explicit ownership and Native Ledger invariants while testing the changed native tick's restoration. |
| Renderer/Portolan/spatial caches | 1.7.2's notes do not claim replacement of geographic filtering, cache pruning, or wrapper cleanup. Remove a cache only after proving the native path solves its particular problem. |
| Native save sharing/transport/idle guards | Reliability persistence adds a save correctness concern. Preserve unknown native fields and compare save generation/load shapes; a small release note does not prove all mod save-memory optimizations are obsolete. |

Evidence for these seams is local: [cached-tick ADR](../adr/0004-cached-simulation-owns-ticks-only-while-enabled.md),
[shared commute queue policy](../commute-queue-conditions.md),
[removed Deck layer lifecycle](../deck-layer-lifecycle.md), and
[native save/load work](../native-save-load-performance.md).

## Targeted verification priorities

1. Run native decision scheduling across every batch boundary, quarter-hour,
   midnight, and time wrap. Check each pop is considered once at the intended
   time, including look-ahead populations and empty batches.
2. Compare indexed and unindexed demand selection against the extracted 1.7.2
   native function. Check stale/replaced demand and edited departure times.
3. Verify worker network updates, terminal/error responses, queued cancellation,
   transfer handling, memory-pressure downsizing, idle retirement, unknown-build
   passthrough, and replacement of the previous wrapper generation.
4. Exercise native-to-cached-to-native transitions and synchronous save
   generation with new reliability fields, guarding against duplicate ledger
   posting or replay of commuter work already prepared by the new scheduler.
5. Retest routing choices on a network where the native route crosses tracks
   unnecessarily, without assuming an unrelated cross-tile algorithm changed.
6. Benchmark native and modded paths under the same save, viewport, speed,
   paused state, and reset diagnostics. Report stalls and memory separately
   from intentionally faster clock throughput.

## Installed-bundle findings and patch decisions

The unmodified game's embedded `package.json` reports **1.7.2**. Its archive SHA-256
is `71dd289001a6a84f75db973eeefb5ef5c676d9e6d2c8f899769d1e939c269397`.
These digests identify the original entries inspected before applying the
compatibility patch. Local extracted source remains Git-ignored under
`.analysis/game-v1.7.2`; the patched installed archive is recorded below.

| Entry | SHA-256 |
| --- | --- |
| `index-NqqqjH9_.js` | `7578256076ff13e3bada8801af26e56c336f83a5c193c9d92c2b9ef0f231240c` |
| `GameMain-DSzNxHOd.js` | `b2cdc60b0366a05c29daf73f4b8943bc5a34dba1184ab24b07202e4475b4d114` |
| `popCommuteWorker.worker-CAqx0wJ7.js` | `01b9c52b1d3b0409430effeab2111f551adeba354e9d96d98bb7122b2612c7c0` |
| `dist/preload/preload.js` | `0b095373ae605b17dee6c0cb105898ec8fd41a108a6dcc128fa449760f7367ce` |

These findings come from the installed code and reproducible harnesses, not
from the public documentation:

- **Retain and update worker budgeting.** Native 1.7.2 constructs one logical
  worker per hardware thread (minimum two), while its new batching dispatches
  only seven simultaneously on a 24-thread fixture. All 24 native workers still
  construct physical workers and retain networks. The verified adapter now
  recognizes the renamed worker and uses six physical workers, then retires idle
  heaps. The actual shipped pool/message handler produces the same 424 controlled
  response records
  and batch order with both configurations. Lower concurrency may reduce routing
  throughput; this is a memory bound, not a measured FPS gain.
- **Keep native staggering and update cached activation.** Native ticks launch
  commuter waves without awaiting completion. Cached activation now blocks new
  native calls, drains already observed waves/ticks, and starts its clock and
  accounting at the final native timestamp. Regression tests reproduce the
  overwritten-assignment/accounting race and cover cancellation. Native
  lookahead selection, midnight wrapping, active journeys and both directions
  are exercised using shipped functions. The optional estimated simulator still
  differs from native capacity, signals, congestion and reliability.
- **Retain the completed-commute index.** It indexes native financial receipts,
  not commuter departure selection. The shipped setter still supports immutable
  reference reuse, replacement and expiry; native lookahead does not replace it.
- **Update directed route costs and the search frontier.** Native route search
  adds a two-unit crossover cost. The shared adapter now matches that preference
  and replaces its repeated queue sorts with a stable minimum heap. The old
  duplicated sorted searches are removed. Canonical-native route editing
  continues to use the game's route finder.
- **Preserve native ribbon picking through clipping.** Native 1.7.2 makes ribbons
  pickable for its route context menu. Dropped/split clipped paths now map their
  rendered picking indices back to the original `band.routes` indices, preventing
  selection of another route. Retained movement/preview wrappers have new
  generations and upgrade tests.
- **Refresh reliability in compact snapshots.** Native 1.7.2 serializes live
  reliability history as numeric tuples. Reusing a schema template previously
  retained old history. The optimized path now serializes only the current
  reliability field, retains demand-compression savings, isolates loader data,
  and verifies the loaded reliability against the staged Native Save. The
  serializer is compared with the actual shipped serializer/deserializer.
- **Retain and requalify save transport.** Native pending-save reads still carry
  the full object through `contextBridge`; Load Game still loads it into the
  renderer and sends it back before navigation. Isolated shipped-code tests
  observe one full-object pending read and two Load Game crossings; the existing
  JSON transport and native staging menu patch eliminate those crossings. The
  installer now accepts only the reviewed 1.7.2 hashes as well as its reviewed
  1.7.0 baseline. It continues to refuse other checksums/builds before writing.

Native improvements do not replace the particular problems addressed by the
remaining geographic, Portolan, memory, receipt-index or save-transfer guards.
There is therefore no verified basis to remove those guards solely because the
game now staggers decisions. The obsolete scheduling assumptions and repeated
sorted route searches above are replaced; no second native scheduler is added.

## Reproduce the shipped-function tests

Run from the repository root after extracting the listed entries with
`tools/inspect-asar.mjs`:

```powershell
node open-world-platform/scripts/test-native-game-bundle.mjs .analysis/game-v1.7.2/dist/renderer/public/index-NqqqjH9_.js
node open-world-platform/scripts/test-native-commute-bundle.mjs .analysis/game-v1.7.2/dist/renderer/public/index-NqqqjH9_.js .analysis/game-v1.7.2/dist/renderer/public/popCommuteWorker.worker-CAqx0wJ7.js
node open-world-platform/scripts/test-native-save-bundle.mjs .analysis/game-v1.7.2/dist/renderer/public/index-NqqqjH9_.js .analysis/game-v1.7.2/dist/preload/preload.js
node open-world-platform/scripts/test-native-game-render-routing.mjs .analysis/game-v1.7.2/dist/renderer/public/index-NqqqjH9_.js .analysis/game-v1.7.2/dist/renderer/public/GameMain-DSzNxHOd.js .analysis/native-index-save.js
```

The lifecycle harness uses a nonempty demand-compression fixture and the existing
consumer lifecycle assertions. Schema validation, geography loading, UI and
telemetry are peripheral stubs. The commuter harness uses the actual scheduler,
pool and message protocol with a controlled asynchronous routing response;
commuter route search itself is not benchmarked. The save harness executes the
preload with an inert Electron bridge; main-process staging results are fixtures.
No harness executes full application startup or operates on the player's saves.

The route/picking harness executes shipped Dijkstra/flip-aware search, native
Layer/PathLayer picking, the picking pipeline and context-menu resolver. Store
contents, band selection, GPU pick hits and coordinate precision are fixtures.
It confirms the old native two-crossover choice becomes the three-straight-track
choice in 1.7.2, and both pieces of a clipped split ribbon resolve to its source
route. The mod's fallback still omits native bearing-based flip costs; this
predates this update. Matching crossover preference does not establish full
route-search equivalence.

An equal-VM CPU benchmark of the removed sorted frontier versus the stable heap
on a 12,289-node/24,576-edge graph measured medians of 194.56 ms and 20.65 ms
(9.42 times faster for this fixture). This exercises the shared directed-search
fallback, not Japan's complete native/canonical route-editing path, a real save,
or its render frame rate. Timing evidence is local and Git-ignored.

## Delivery verification

The shared JavaScript suite passes **1,140 tests**, Japan's selected-consumer
suite passes **7**, and the additional NEC lifecycle/consumer suite passes **18**.
All four shipped-function harnesses pass against the extracted 1.7.2 files.
The lifecycle harness also passes against the retained inspected 1.7.0 baseline.
Windows synthetic build tests use a temporary directory on E: to keep relative
module imports on the repository's drive; no product source was changed for
that machine-local convention.

Japan Open World is rebuilt from `prototype/japan/mod` with **47 Tile Packages**.
Delivery markers include `runtime-audit-game-1.7.2-v1`,
`native-commute-worker-budget-v3`, `open-world-cached-simulation-v19`,
`native-directed-track-search-v1.7.2`, and `native-reliability-snapshot-v1`.
The installed consumer is `local.japan-open-world` under the game's mod directory.
Its bundle matches the built bundle byte for byte, with SHA-256
`54ea56e9a71a51fb6e7b35f8a9427f8fb330a4d8091ebe69b3f3c1a44c1479e2`
and identical UTC modification time `2026-10-01T17:15:14.2170090Z`.
All listed markers and `openWorldPortolanSourcePickingInfo` are present in both.
No other consumer was rebuilt or installed as a proxy.

The reviewed native save archive was applied separately after the user saved
and closed the game; normal mod builds do not alter the host game. Its installed
SHA-256 is `d6d7999f1b0ae5ad6e868e879052a3be5ef3e57b386edf35c3488eb57b314960`.
The original archive is retained as `app.asar.before-open-world-save-read`.
The World service at `http://127.0.0.1:8799/_health` returns HTTP 200 with
`X-PMTiles-Server-Version: native-pmtiles-directory-v4` and
`X-OpenWorld-Route-Archive: stored-driving-routes-v1`.

Live verification on 2026-10-01 relaunched the game and loaded the latest
available Japan save, `JP_PREF_33` (Okayama), paused. Its runtime owns manifest
`local.japan-open-world` and reports the audited build marker, game version
1.7.2, cached simulator v19, movement guard generation 36, reliability serializer
v1, directed-search v1.7.2, and both installed save-transport markers.
Both native ribbon layers are pickable and use the source-index wrapper.
Resetting movement diagnostics with `{ reset: true }` produced `probe-1` with
18 installed probes; the camera was restored afterward. This is a smoke check,
not a representative frame-rate benchmark.

A paused native refresh of 424 directional commute requests exercised the real
game network and worker protocol: 24 logical workers used six physical workers,
peak busy count was six, eight batches completed, and all six physical workers
retired after becoming idle. Cached simulation was restored to its original
enabled setting and became ready with 32,910 assigned populations. The smoke
check preserved the clock, money and persisted mode preferences; the game remains
paused. Temporary movement instrumentation was disabled after capture. Detailed
machine-local evidence is retained in Git-ignored `.analysis/v172-live-verification.json`.
