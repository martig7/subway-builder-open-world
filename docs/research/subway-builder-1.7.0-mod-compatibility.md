# Subway Builder 1.7.0 mod compatibility

Research date: 2026-09-02
Scope: Subway Builder's first-party 1.7.0 changelog and stable modding docs,
read-only inspection of this repository, and read-only extraction/decompilation
of the locally installed 1.7.0 application bundle. The game bundle was not
executed during this research.

## Outcome

There is no documented manifest migration or Modding API version bump required
for 1.7.0. The public API is still documented as `1.0.0`, and the documented
manifest fields remain `id`, `name`, `description`, `version`, `author.name`,
and `main`. The three runnable consumers all use the same
`open-world-platform` integration boundary, so one shared compatibility update
can cover New York, NEC, and Tokyo-Kanagawa. [API introduction](https://www.subwaybuilder.com/docs),
[manifest guide](https://www.subwaybuilder.com/docs/getting-started/first-mod)

The mod is **not yet proven compatible**, however. Version 1.7.0 rewrote or
changed interlined route rendering, station-marker rendering, track curves,
track directions, route editing, grade-crossing speed/throughput behavior,
time-of-day TPH limits, and custom-city collision handling. Those are the same
areas where Open World reaches through the undocumented Zustand callback seam
or touches native renderer internals. [Official 1.7.0 changelog](https://www.subwaybuilder.com/changelog)

The highest-priority work is therefore:

1. Update the shared adapter's inspected-game compatibility line from 1.6.0 to
   1.7.0 and strengthen its feature probe before allowing mutation.
2. Revalidate the interlining, route-preview, track-edit, save/load, and
   simulation wrappers against a real 1.7.0 store.
3. Revalidate station-marker, route, road, and movement virtualization against
   the new renderer.
4. Replace Zustand reads/events with documented APIs where the public surface is
   now sufficient, while keeping guarded private access only for full snapshot
   restore, exact clock/city switching, and canonical-network mutation.

## Bundle verification: installed 1.7.0 (2026-09-02)

This section supersedes the earlier “verify against a real 1.7 bundle”
assumptions where static inspection can answer them. The installed archive is
`%LOCALAPPDATA%\Programs\Subway Builder\game\resources\app.asar`; its embedded
`package.json` reports `metro-maker4` version `1.7.0`. The inspected archive and
renderer chunks are:

| Artifact | Extracted size | SHA-256 |
| --- | --- | --- |
| `app.asar` | 260,800,381 bytes | `7B112DD803E0B5CABC3C18A4CD11F33FF120E1864968AA2A93292504647E2A6E` |
| `dist/renderer/public/index-CM0DI1Ho.js` | 10,629,576 bytes | `99FD5ED94F0C77636F32FE1F21C6165BC6649EA528BEB03BEE7AD87D4B8BD67D` |
| `dist/renderer/public/GameMain-COH5GUdy.js` | 3,811,866 bytes | `D93B1E157F79E90F52A9448EB488902DDCCDE0608FC8D043000DC729CAF69717` |

Offsets below are approximate zero-based character offsets in the extracted
UTF-8 text. They are reproducible search anchors, not source-line numbers or
ASAR payload offsets. Only small surrounding fragments were inspected; no
substantial game source is reproduced here.

### Confirmed: the required Zustand actions retain their names

The callback-global token `__subwayBuilder_storeCallbacks__` remains present in
`index-CM0DI1Ho.js` near offset 7,327,103. The store object contains these exact
action keys and signatures:

| Store action | Approx. text offset | 1.7.0 static signature |
| --- | ---: | --- |
| `setRoutes` | 8,417,694 | `(routes, regen = false)` |
| `setPreviewRoute` | 8,420,121 | `(routeOrNull)`; entering preview pauses time |
| `discardPreviewRoute` | 8,420,823 | `()`; clears pending station-node edits and recalculates routes |
| `setTimeConfig` | 8,423,122 | `(patch)` shallow-merges the existing time config |
| `setTracks` | 8,447,296 | `({newTracks, newTrackGroups, signalsUpdate, regenRoutesWithTrackIDs, regenStations, skipHistory})` |
| `batchPreviewRouteUpdates` | 8,480,410 | `async ()` |
| `confirmRouteChange` | 8,485,758 | `(argument)` |
| `handleIncrementGameState` | 8,501,117 | `async ()` |
| `loadSave` | 8,527,205 | `(save)`; runs migrations through V4 before loading |
| `generateSave` | 8,548,434 | `({name})` |
| `simulateCommutes` | 8,559,822 | `async ({popCommutes, startMovements = false})` |
| `recalculateAllRouteGeojsons` | 8,562,514 | `async (routes)` |
| `loadInitialData` | 8,565,594 | `async (cityCode)` |

Therefore no private-action rename migration is indicated for snapshot,
network, clock, simulation, or route-preview operations. The runtime feature
probe should still check these signatures/shapes rather than merely their
presence. In particular, 1.7's `setPreviewRoute` now owns the pause/resume
transition, and both preview discard and preview entry can initiate an async
route recalculation. Existing wrappers must preserve that behavior.

### Confirmed break: the old interlining collection and layer contract is gone

`interlinedFeatureCollection` does not occur in either inspected renderer
chunk. The 1.7 initial store instead contains `portolanDiagram` and
`portolanProgress` (`index-CM0DI1Ho.js`, near offset 8,389,946; the
corresponding store initializer begins near offset 8,407,963).
`recalculateAllRouteGeojsons` still exists, but its interlining branch now calls
`requestPortolanDiagram()` after updating regular/simplified GeoJSON (offsets
8,562,514–8,564,200). The request is coalesced and deferred; its implementation
begins near offset 7,994,763 and charts the then-current store
routes/stations/tracks, not an `interlinedFeatureCollection` returned from the
wrapper's route argument.

The new native Deck layer IDs in `GameMain-COH5GUdy.js` are:

- `portolan-ribbons` near offset 3,228,070;
- `portolan-ribbons-under` immediately after it;
- `portolan-station-pills` near offset 3,230,090; and
- `portolan-cats` / `portolan-cat-text` for route bullets and long labels.

The old `interlined-routes` and `interlined-routes-under` IDs do not occur. The
Portolan ribbon layer consumes binary `positions`, `startIndices`, color
attributes, and per-vertex offset vectors rather than a GeoJSON feature
collection with `properties.offset` (`GameMain-COH5GUdy.js`, approximately
offsets 3,225,118–3,226,500).

This is a required P0 runtime change:

1. Remove `interlinedFeatureCollection` as the cache-hit/result-completion gate.
   The wrapper can still install because `recalculateAllRouteGeojsons` exists,
   but the 1.7 cache can never hit while it checks the removed collection.
2. Do not treat completion of the wrapped recalculation as completion of
   Portolan charting. Wait for `portolanDiagram`/progress or otherwise invalidate
   the deferred chart explicitly.
3. Replace the geographic overlay's `interlined-routes` ID matcher. The existing
   GeoJSON `properties.offset` clipping path cannot transform the binary ribbon
   data and needs a Portolan-aware filtering strategy or a clearly diagnosed
   fallback.

### Confirmed change: normal station markers moved to Deck

The new station renderer builds Deck layers in
`DeckglStationMarkersLayers`. Its exact layer IDs are
`station-marker-dots` (`GameMain-COH5GUdy.js`, near offset 3,218,380) and
`station-marker-labels` (near offset 3,219,755). Portolan interchange pills are the
separate Deck layer noted above. The literals `.maplibregl-marker`,
`.mapboxgl-marker`, `_markers`, and `_markerManager` do not occur in either
game chunk. Route-edit mode still constructs MapLibre `Marker` components, so
the DOM adapter remains relevant as an edit-mode fallback; it is no longer the
normal station dot/label path.

Open World's generic Deck virtualizer already clips array-backed objects with a
`position`, which is structurally compatible with the new dot and label data.
Compatibility still requires a focused runtime test proving that the wrapper
sees `station-marker-dots`, `station-marker-labels`, and
`portolan-station-pills`, plus explicit capability diagnostics for those IDs.
The old DOM-specific zoom and styling controls cannot govern normal 1.7 station
markers. The public `STATION_MARKER` constants can replace supported styling
mutations but still do not expose per-station filtering.

### Confirmed implementation priorities

| Priority | Required update | Bundle evidence |
| --- | --- | --- |
| P0 | Replace the `interlinedFeatureCollection` cache/result gate and old GeoJSON-offset cache/filter contract with a Portolan-aware lifecycle. | Old state key and layer IDs are absent; `portolanDiagram`, deferred `requestPortolanDiagram()`, binary ribbons, and `portolan-*` IDs replace them. |
| P0 | Verify and explicitly recognize normal station Deck layers while retaining the DOM path for route-edit markers. | Normal stations are `station-marker-dots`, `station-marker-labels`, and `portolan-station-pills`; generic array/position clipping appears compatible but needs a live proof. |
| P0 | Migrate persistent finance/statistics from `lastCommute` to per-direction `commutes`, retaining a legacy warm-up policy. | The bundle contains both `homeToWork` and `workToHome` state paths; the official 1.7 API declares those summaries persistent. |
| P0 | Decide how tile snapshots preserve or deterministically rebuild 1.7 per-direction commute summaries. | Native save V4 writes them only inside `compressedDemandData` format V2, while `compactNativeSnapshot()` currently deletes that field. |
| P1 | Preserve `hobby` spline metadata, editable nodes, and lane directions across snapshots, projections, repairs, and restores. | `curveGeometry`, `nodes`, lane-direction construction state, and saved `lastLaneDirections` are present in the 1.7 chunks. |
| P1 | Version and retest the existing save, clock, simulation, and route-preview wrappers rather than renaming them. | All required action names survive, but preview now pauses/resumes routes and route recalculation is async/deferred. |

### Confirmed new native track/save fields

The bundle confirms that the undocumented track representation changed in the
areas already identified by the release notes:

- the spline builder emits `curveType: "hobby"`, `curveGeometry`, and editable
  `nodes` (`index-CM0DI1Ho.js`, offsets 5,189,300–5,190,000);
- generated/reprojected track objects preserve `curveGeometry` and use the same
  `hobby` curve type (for example offsets 5,414,300–5,415,200);
- lane direction choices are carried by the lane/track-group construction
  representation, while `lastLaneDirections` is explicitly loaded from and
  written to saves (`index-CM0DI1Ho.js`, offsets 8,540,000 and 8,551,900).

Snapshot and projection code must preserve these unknown native fields
losslessly. Any path that synthesizes a track or track group from only legacy
`coords`, `curveType`, and alternating lane assumptions needs a 1.7 fixture and
an explicit policy before it is considered compatible.

### Confirmed persistence risk: compact snapshots drop the new commute summaries

Native save V4 writes commuter state under `data.compressedDemandData`. Its
internal format is version 2 and serializes separate `homeToWork` and
`workToHome` summaries plus `lastCommute`. Open World's
`compactNativeSnapshot()` intentionally deletes `compressedDemandData`, along
with the older demand payload fields, because demand was previously treated as
static tile-package data. In 1.7 that also deletes the newly persistent
directional mode-choice/time/cost state.

Before release, choose and test an explicit policy: store the minimal summaries
in an Open World sidecar, or deterministically recompute both legs after tile
restore. Do not assume the native 1.7 load path can preserve data that the
snapshot compactor has removed.

### What still requires a live smoke test

Static inspection proves the keys and renderer structures above, but it does
not prove that the callback global is assigned before the mod probes it, that
hot reload replaces retained wrappers, or that an Open World save round-trip
preserves every runtime-only object. Keep the capability snapshot, save/load,
route-edit, interlining, marker filtering, and selected-consumer tests in the
verification matrix below. They are now focused behavior tests rather than
schema-discovery work.

## Why this is a shared-platform update

The relevant integration file still describes itself as the “Subway Builder
1.6.0 integration boundary,” expects API `1.0.0`, and requires private
`generateSave`, `loadSave`, `loadInitialData`, and `setTimeConfig` actions
([adapter](../../open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js#L29)).
The same class also wraps native interlining recalculation
([adapter](../../open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js#L315)),
route preview/edit actions, track mutation, and the simulation tick
([adapter](../../open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js#L1614)).

Those shared sources are bundled independently by the three runnable consumers:

- `local.ny-state-six-tile-canary` under `prototype/ny-state/mod`
- `local.nec-corridor-open-world` under `prototype/nec-corridor/mod`
- `local.tokyo-kanagawa-open-world` under `prototype/tokyo-kanagawa/mod`

No consumer was selected for building or installation in this research-only
task. Compatibility delivery must later rebuild and test the consumer that is
actually being run; a platform-only test is not sufficient.

## Required compatibility work

### 1. Treat the private store seam as changed until probed

The existing capability check proves API `1.0.0` and the presence of a small
set of private actions, but it does not currently prove the shapes and behavior
of the private functions most exposed to the 1.7 rewrite:

- `recalculateAllRouteGeojsons`
- `setTracks`
- `batchPreviewRouteUpdates`, `setPreviewRoute`, and `confirmRouteChange`
- `handleIncrementGameState` and `simulateCommutes`
- `trackGraph`, `trackGroups`, `stNodes`, route `stCombos`, and interlined
  feature collections
- MapLibre marker DOM and `map.__deck` layer identities

Add these as explicit 1.7 capability/behavior probes, refuse mutation with a
clear diagnostic when a required shape is absent, and update every retained
wrapper generation so a hot reload removes or replaces the 1.6 wrapper. The
official API version alone cannot distinguish game 1.6 from 1.7 because it
remains independently versioned as `1.0.0`. [API introduction](https://www.subwaybuilder.com/docs)

### 2. Revalidate interlining rather than assuming the old calculation contract

Open World replaces `recalculateAllRouteGeojsons` with a cache/filter wrapper
and fingerprints route geometry before delegating to the native method
([adapter](../../open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js#L315)).
Version 1.7.0 changed parallel/interlined routes from an experimental overlay
into a new parallel-ribbon presentation, and the public constants docs describe
the schematic system as `GAME_COLORS.PORTOLAN`. The docs explicitly say that
the game owns the diagram geometry; mods may change its presentation, not its
geometry. [1.7.0 changelog](https://www.subwaybuilder.com/changelog),
[constants API](https://www.subwaybuilder.com/docs/api-reference/constants)

The wrapper must be tested for:

- current argument and return shapes;
- temporary/empty routes during the new pause-to-edit flow;
- invalidation after moving blueprint curve nodes or changing lane direction;
- time-of-day route schedules and the new TPH clamp behavior;
- reload replacement of a 1.6 wrapper and retention of exactly one 1.7 wrapper;
- both visual-interlining enabled and disabled.

Do not use the new constants as a substitute for the cache wrapper unless the
wrapper's actual correctness/performance purpose has been removed. The durable
constants only control presentation.

### 3. Revalidate route editing, track direction, and curve preservation

The 1.7.0 track model now supports modified Euler curves, movable blueprint
nodes, and lane directions beyond alternating forward/backward patterns. It
also permits editing track/stations used by routes by pausing those routes.
Open World wraps the private preview and track setters and reconstructs some
track groups with a `parallel` lane type and a `heavy-metro` fallback
([network projection](../../open-world-platform/src/runtime/network-projection.js#L624),
[adapter](../../open-world-platform/src/runtime/adapters/subway-builder-game-adapter.js#L2270)).
[Official 1.7.0 changelog](https://www.subwaybuilder.com/changelog)

The public `Track` type still exposes coordinates, elevation, `trackType`,
`reversable`, and the legacy `curveType`, but it does not document the new lane-
direction or Euler-control-point representation. The Build API likewise only
documents `coords`, elevations, `trackType`, and `trackLanesType` values
`single`, `parallel`, and `quad`. These new internal fields therefore remain an
unsupported seam and must be discovered from a live 1.7.0 track/save fixture,
then preserved losslessly through capture, projection, edit, and restore.
[type reference](https://www.subwaybuilder.com/docs/api-reference/types),
[Build API](https://www.subwaybuilder.com/docs/api-reference/build)

Add regression fixtures for single-direction and mixed-direction parallel
tracks, an edited Euler curve, a route paused during track editing, and a save
round-trip. Also verify that projected or repaired tracks retain their native
`trackType`: 1.7.0 now forbids intersections between different train types, so
silently defaulting a light-rail track to heavy metro could turn a repair into
an invalid network. [Official 1.7.0 changelog](https://www.subwaybuilder.com/changelog)

### 4. Revalidate station-marker and road virtualization

The geographic overlay currently:

- matches exact native Tailwind class strings to hide marker content;
- uses hard-coded station-marker zooms 10 through 16;
- patches MapLibre layer zoom ranges;
- recognizes native road and rail Deck layers by ID patterns; and
- batches private MapLibre marker `_update` listeners.

These details live in
[geographic-context-overlay.js](../../open-world-platform/src/runtime/ui/geographic-context-overlay.js#L21)
and
[renderer-virtualization.js](../../open-world-platform/src/runtime/ui/renderer-virtualization.js#L492).
Version 1.7.0 reworked station-marker rendering, split station labels from dots,
added collision avoidance and multi-dot station groups, changed interlining,
and changed road/movement rendering performance. Exact DOM selectors and layer
IDs are therefore high-risk. [Official 1.7.0 changelog](https://www.subwaybuilder.com/changelog)

The public constants now provide durable presentation controls that should be
used for supported styling instead of mutating native layers where they meet the
same need:

- `GAME_COLORS.PORTOLAN.ROUTE_ZOOM`, `MARKER_ZOOM`,
  `RIBBON_WIDTH_STOPS`, `MARKER_ICON_SCALE_STOPS`, and
  `OFFSET_SCALE_STOPS`
- `GAME_COLORS.STATION_MARKER.*`, including dot/pill diameters, borders,
  grouping zooms, `PILL_OFF_CORRIDOR_M`, `FADE_MS`, and `LABEL_ZOOM`
- `GAME_COLORS.TRACK_ARROWS.*`
- `GAME_COLORS.ROAD_VISUALS.{highway,major,medium,minor}` and
  `ROAD_STRUCTURES.*`
- `GAME_COLORS.MIN_ROAD_PIXEL_WIDTH` and `SIMPLE_ROUTE_ZOOM`

Use `modifyColors()` for changes and `utils.getColors()` for feature/readback
checks. Objects deep-merge, but documented arrays replace wholesale. Most of
these values apply on map redraw; constants involved in geometry or grouping
may require a reload. [constants API](https://www.subwaybuilder.com/docs/api-reference/constants)

These controls do **not** replace Open World's geographic per-tile filtering:
the public API still exposes no marker registry or per-marker visibility hook.
The generic Deck filter should handle normal 1.7 station arrays, while the
DOM/MapLibre fallback remains necessary for route-edit markers. Both paths
should feature-detect their 1.7 structures and fail visibly rather than
silently showing off-tile markers.

### 5. Migrate finance and statistics to the durable per-direction commute model

Version 1.7.0 persists commuter choices separately for both commute legs. The
documented aggregate query is now:

```js
api.gameState.getModeChoiceStats('homeToWork');
api.gameState.getModeChoiceStats('workToHome');
```

The no-argument form remains the home-to-work aggregate. On a save created
before per-direction data existed, an explicit direction initially reports the
population as `unknown` until that leg completes once; the no-argument form has
no such gap. [game-state API](https://www.subwaybuilder.com/docs/api-reference/game-state)

For per-pop data, `gameState.getDemandData()` now documents
`Pop.commutes.homeToWork` and `Pop.commutes.workToHome` as the persistent
per-leg summaries. The docs explicitly advise reading mode share from
`commutes`, not `lastCommute`, because `lastCommute` flips with the most recent
journey and its transit paths can be dropped from saves. Both fields must still
be treated as optional during first-run or legacy-save warm-up.
[type reference](https://www.subwaybuilder.com/docs/api-reference/types)

Open World's simulation still needs private `simulateCommutes` to force a
specific recalculation and private movement state for in-flight reconstruction.
The new API can replace read-only health/statistics traversal, not that mutating
behavior. Add a 1.6-save-to-1.7 test that verifies both directions repopulate
without discarding transit paths or cross-tile results.

This is a required code change, not just a validation item. The native finance
model currently reads `pop.lastCommute.modeChoice.transit`, attributes revenue
from `lastCommute.transitPaths`, and treats that one result as a round trip
([native finance](../../open-world-platform/src/runtime/native-finance-model.js#L304)).
In 1.7, that can price whichever leg happened most recently and can lose its
path attribution after a save. Update the model to account for home-to-work and
work-to-home separately from `pop.commutes`, with an explicit legacy warm-up
policy. Because `CommuteSummary` does not include route path segments, obtain a
real 1.7 save fixture before choosing how to attribute per-route revenue; do not
silently reuse the opposite leg's `lastCommute.transitPaths`.

The synthetic off-tile population builder also creates only `lastCommute`
([off-tile demand](../../open-world-platform/src/runtime/off-tile-native-demand.js#L193)).
Teach it and the test fixtures to emit optional per-direction `commutes`
summaries. Static bundle inspection confirms that native save V4 places these
summaries inside `compressedDemandData` format V2, while Open World's current
snapshot compactor deletes that entire field. Preserve the minimal summaries in
a sidecar or deterministically rebuild both legs; test that choice against a
generated 1.7 save so the fields are neither discarded nor duplicated into an
oversized sidecar.

### 6. Custom city registration requires collision testing, not premature renaming

The city docs continue to require a unique uppercase `code`; `minZoom` remains
optional. Static bundle inspection confirms that `registerCity` now attaches
the registering `modId` and derives a mod-scoped city UID. It skips duplicate
registration by the same mod and can retain another built-in/modded city with
the same bare code under a different UID. The public docs still do not promise
collision precedence as a durable contract.
[city API](https://www.subwaybuilder.com/docs/api-reference/cities),
[Official 1.7.0 changelog](https://www.subwaybuilder.com/changelog)

Tokyo-Kanagawa uses namespaced codes `JP_TOKYO_MAINLAND` and
`JP_KANAGAWA_MAINLAND`, not a generic `TOKYO` code
([tile views](../../worlds/tokyo-kanagawa/geography/tile-views.json#L1)). Keep
those stable for existing saves. On 1.7.0, enumerate `utils.getCities()` after
mod load and assert that both custom codes and the vanilla Japanese cities are
present exactly once. Test the country tabs and the large multi-city selector.
Omitting an explicit `minZoom` may be evaluated later, but it is not required
for compatibility.

### 7. Train type changes are available but do not require a current data migration

No current Open World source registers or modifies a train type. Existing
heavy-metro worlds therefore need no train-definition change solely for 1.7.0.
The documented built-in train ID union now includes `light-rail`, and the train
registry can be inspected with `trains.getTrainTypes()` / `getTrainType()`.
[type reference](https://www.subwaybuilder.com/docs/api-reference/types),
[train API](https://www.subwaybuilder.com/docs/api-reference/trains)

For future custom trains, the new supported top-level fields are:

```js
{
  allowGradeCrossing: true,
  gradeCrossingSpeedLimit: {
    highway: 11.2,
    major: 11.2,
    medium: 13.4,
    minor: 17.9
  },
  gradeCrossingSpeedLimitApproachDistance: 150
}
```

Speed values are meters per second and are sparse per road class. The approach
distance is measured along connected track on each side of the crossing;
omitting it defaults to zero, which caps only the segment containing the
crossing. Existing `allowGradeCrossing`, cost, maintenance, and per-road-class
TPH fields remain top-level rather than under `stats`.
[train API](https://www.subwaybuilder.com/docs/api-reference/trains)

Train descriptions now have a durable fix: use
`trains.modifyTrainType(id, { description })`. The method deep-merges a patch,
while `registerTrainType` registers/replaces a complete definition and requires
all `stats` fields. Do not write the train registry through Zustand.
[train API](https://www.subwaybuilder.com/docs/api-reference/trains)

## Durable replacements for current Zustand access

| Need | Documented 1.7 API | Disposition |
| --- | --- | --- |
| Read stations, routes, tracks, trains | `gameState.getStations/getRoutes/getTracks/getTrains` | Use for read-only profiles, inventories, and diagnostics. Full native objects needed for lossless restore may still require the store. |
| Read demand and direction-specific mode share | `gameState.getDemandData()`, `getModeChoiceStats(direction)` | Use for statistics and health checks. Keep private access only for mutation/in-flight movement reconstruction. |
| Observe construction and service changes | `onStationBuilt/Deleted`, `onRouteCreated/Deleted`, `onTrackBuilt`, `onBlueprintPlaced`, `onTrackChange`, `onScheduleChange`, `onTrainSpawned/Deleted` | Replace polling/observer wrappers where these events cover the required change. There is still no documented general route-edited or full-network-change hook. |
| Pause/resume and observe pause | `actions.setPause`, `gameState.isPaused`, `onPauseChanged` | Prefer publicly. Actions are deferred to a microtask, so transition code must await the hook/settled state rather than read immediately. Exact atomic snapshot transactions may still need `setTimeConfig`. |
| Money and ticket price | `actions.setMoney`, `actions.setTicketPrice`, getters and change hooks | Replace callback-global writes when deferred semantics are acceptable. |
| Current city and map | `utils.getCityCode`, `utils.getMap`, `onCityLoad`, `onMapReady` | Already durable. `map.__deck`, marker private fields, DOM class names, and native layer IDs remain unsupported. |
| Register/bind custom cities | `registerCity`, `cities.setCityDataFiles`, `map.setTileURLOverride` | Already durable. The API does not document a replacement for `loadInitialData` to switch the loaded native city payload in place. |
| Save identity/events | `getGameSessionId`, `getSaveName`, `onGameSaved`, `onGameLoaded` | Use for binding and observation. There is no documented full native `generateSave`/`loadSave` action for Open World's internal tile checkpoints. |
| Styling constants | `modifyColors`, `utils.getColors` | Use for supported road, marker, arrow, and interlining presentation. |
| Train description/crossing behavior | `trains.modifyTrainType` / `registerTrainType` | Fully public; do not use Zustand. |

The public actions documentation warns that most actions use `queueMicrotask`;
the state change is not visible on the next line, and a corresponding hook
should be used to observe completion. That timing difference matters to Open
World's pause/capture/load/resume transaction and prevents a blind mechanical
replacement of synchronous store actions. [actions API](https://www.subwaybuilder.com/docs/api-reference/actions)

## 1.7.0 verification matrix

Before declaring compatibility, test against a real 1.7.0 renderer in this
order:

1. **Capability snapshot:** record game version/build marker, API version,
   private method names, critical state keys, native city registry, train
   registry, color constants, and MapLibre/Deck layer IDs.
2. **Clean start and reload:** start a new game, load an existing save, then run
   `await SubwayBuilderAPI.reloadMods()`. Confirm one wrapper/listener generation
   and that custom cities/layers are restored. The official hot-reload API
   clears callbacks, UI, custom map assets, train types, and cities before
   re-executing mods. [development tools](https://www.subwaybuilder.com/docs/api-reference/development)
3. **Network editing:** build and edit straight and curved blueprints, move a
   curve node, change lane directions, edit a track used by a paused route, and
   construct. Assert no fields disappear from the native save.
4. **Interlining:** exercise shared corridors, route creation/deletion/editing,
   visual interlining on/off, and zoom transitions. Confirm the cache invalidates
   once and route ribbons remain coherent.
5. **Station/road layers:** toggle station dots and labels independently, move a
   multi-dot station group, switch tiles at low/high zoom, change map style, and
   verify no off-tile markers, stale road layers, or duplicate movement layers.
6. **Train compatibility:** enumerate `light-rail`; test same-type and different-
   type intersections; verify reconstructed groups retain `trackType`; exercise
   grade-crossing TPH and speed limits at multiple time-of-day schedules.
7. **Saves and commutes:** load a 1.6 save, run both commute legs, verify
   `Pop.commutes` persistence, mode-choice aggregates, station groups, bonds,
   route financials (without doubling one leg), and Open World sidecar binding
   across save/load/autosave.
8. **Each selected consumer:** run the platform suite plus that consumer's
   behavioral suite, build its own `dist/index.js`, verify a unique 1.7 marker,
   install that same manifest, and prove the running renderer reloaded it.

The docs expose schemas for demand, roads, and runways/taxiways, plus binary
building-index validation. Re-run those validations for any rebuilt city data;
1.7's Japan additions and city-conflict fix do not remove the need for unique
codes and valid data. [development tools](https://www.subwaybuilder.com/docs/api-reference/development),
[city API](https://www.subwaybuilder.com/docs/api-reference/cities)

## Bottom line

No manifest rewrite or wholesale platform redesign is indicated. The work is a
focused 1.7 adapter hardening and renderer regression pass. Public 1.7 endpoints
now cover directional commute statistics, persistent per-leg mode share,
train descriptions, grade-crossing speed limits, and visual constants. They
should replace private reads or writes where their semantics match. Full native
snapshot restore, exact clock/city switching, canonical-network mutation, and
per-tile renderer virtualization remain outside the documented API and must stay
behind strict, versioned feature probes until Subway Builder exposes deeper
public endpoints.
