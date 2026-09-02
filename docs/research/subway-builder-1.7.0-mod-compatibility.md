# Subway Builder 1.7.0 mod compatibility

Research date: 2026-09-02
Scope: Subway Builder's first-party 1.7.0 changelog and stable modding docs,
plus read-only inspection of this repository. No game bundle was installed or
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
The DOM/MapLibre fallback remains necessary for that behavior, but it should
feature-detect the 1.7 structure and fail visibly rather than silently showing
off-tile markers.

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
summaries. Audit snapshot compaction against a generated 1.7 save as well, so
the newly persistent fields are neither discarded nor duplicated into an
oversized sidecar.

### 6. Custom city registration requires collision testing, not premature renaming

The city docs continue to require a unique uppercase `code`; `minZoom` remains
optional. The 1.7.0 changelog says minimum zoom is now derived automatically
from city bounds and that modded cities no longer conflict with future vanilla
cities, but it does not document collision precedence or a migration rule.
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
