# Open-world Subway Builder mod feasibility

Research date: 2026-08-10  
Scope: the current public Subway Builder modding documentation (marked **Stable**, API version `1.0.0`), directly relevant first-party MapLibre documentation, and a read-only inspection of the installed Subway Builder 1.6.0 Electron bundle.

## Executive verdict

There are really two different projects hiding inside the phrase “open world”:

| Target | Feasibility | Verdict |
| --- | ---: | --- |
| One very large visual map with camera travel between regions | **High (8/10)** | The public map/city APIs already support this. |
| One large native network, with off-screen demand approximated by the mod | **Medium (6/10)** | Plausible with public demand mutation, but infrastructure and native simulation remain global. |
| One detailed native tile at a time, with inactive tiles stored and simulated coarsely | **Medium-high prototype (7/10)** | Practical on the installed build through an undocumented global store/save bridge. |
| Seamless native trains and passengers crossing unloaded tile boundaries | **Low (2–3/10)** | There is one global live game state; cross-tile continuity must be represented as portal/gateway events. |
| Maintainable public release using undocumented hooks | **Medium-low (about 5/10)** | Technically workable, but every game update can change bundle names, save schema, or hidden functions. |

The best design is a **same-city, tile-per-snapshot hybrid**: one tile is hydrated in Subway Builder's native state, inactive tiles run a mod-owned hourly aggregate model, and boundary stations act as gateways. The installed bundle contains a decisive undocumented hook—`globalThis.__subwayBuilder_storeCallbacks__.getState()`—that exposes native `generateSave`, `loadSave`, and simulation/state actions to ordinary renderer-side mod code. This turns exact active-tile snapshot swapping from “not supported” into a credible prototype.

It does **not** reveal a dormant multi-world system. The engine still has one current city/store and one game loop. Consequently, the attainable experience is segmented open world with short loading transitions, not a truly seamless simulation in which the same train keeps moving through unloaded physical track.

## Evidence versions and reproducibility

The installed `app.asar` reports package version **1.6.0**. Its SHA-256 at research time was `2FB0D3FCB5B22BEC545D890D7352F50E8C363E4F4B622DD38FEC77B2C07FDA71`.

Local evidence below uses paths of the form:

`C:\Users\darkd\AppData\Local\Programs\Subway Builder\game\resources\app.asar :: <entry>:<line>`

The repository includes `tools/inspect-asar.mjs`, which can list or extract those entries without modifying the installed game. Line numbers refer to the extracted text of the named ASAR entry.

## Preliminary API-only verdict

The documented API is sufficient for a convincing **large contiguous custom city with fast camera travel between named regions**, but it is not sufficient for a native, seamless **world-partition system** in which gameplay regions are loaded/unloaded and the same native simulation runs at a lower level of detail outside the active region.

| Capability | API-only feasibility | Reason |
| --- | --- | --- |
| Stream visual basemap tiles | High | Custom raster/vector sources, per-city tile URL overrides, and raw MapLibre access are public. |
| Move the player between distant regions of one map | High | The raw MapLibre instance is exposed; MapLibre supports animated `flyTo`/instant camera changes and map events. |
| Define a very large custom play area | Medium | A custom city can point to wide-area tiles and datasets, but demand, building collision, and road data are configured as whole-city files rather than spatially paged simulation chunks. Official docs warn that large maps can exhaust renderer memory. |
| Run native simulation at reduced fidelity outside the visible region | Low / undocumented | Simulation cadence controls are global speed-tier settings. They are not per-region, per-entity, or visibility-aware, and batching does not reduce the amount of simulation work per game-hour. |
| Implement a mod-owned coarse off-region model | Medium | Hour/day hooks, read-only network snapshots, money actions, runtime demand editing, and persistent JSON storage are enough to maintain aggregate off-region demand/economics. Exact native train/passenger state cannot be suspended and restored through the public API. |
| Treat registered cities as seamlessly switchable tiles | Low | The public city API registers choices and their data files; it exposes a city-load event, but no documented command to load/swap the active city or retain several live city states inside one playthrough. |

The most credible API-only prototype is therefore a **single, geographically large custom city** divided by the mod into logical regions. Camera transitions are real; visual tiles stream normally. The mod could remove or aggregate off-region commuter populations and maintain coarse hourly economics in its own storage, then re-create demand when a region becomes active. Constructed tracks/stations would remain in the one native world, however, and native trains/routes cannot be serialized, suspended, and restored losslessly with documented methods. This is a hybrid approximation, not engine-level open-world streaming.

## Public documentation and API evidence

### 1. The documented “tiles” API is a rendering interface, not a world-partition interface

The [API overview](https://www.subwaybuilder.com/docs/api-reference) divides the surface into lifecycle hooks, actions, read-only game state, city registration, map customization, build automation, storage, and utilities. Its map namespace is described as adding map sources/layers/styles; it does not describe region activation, world chunks, entity streaming, or multiple simultaneous simulation contexts.

The [Map Customization reference](https://www.subwaybuilder.com/docs/api-reference/map) supports:

- `map.registerSource(id, source)` for raster/vector tile sources;
- `map.registerLayer(...)` and persistent custom layers;
- `map.registerStyle(...)`;
- `map.setTileURLOverride({ cityCode, tilesUrl, foundationTilesUrl, maxZoom })`;
- `map.setLayerOverride(...)` and per-city default layer visibility;
- routing-service overrides and `map.queryRoute(...)`;
- `utils.getMap()` to retrieve the raw MapLibre map instance.

These facilities make a wide visual map and region-to-region camera travel straightforward. They do not partition the game simulation. The raw map object is nevertheless useful for UX: Subway Builder explicitly exposes it, and MapLibre's official [camera example](https://maplibre.org/maplibre-gl-js/docs/examples/fly-to-a-location/) documents `map.flyTo({ center, ... })`; the [MapLibre introduction](https://maplibre.org/maplibre-gl-js/docs) says the `Map` object manipulates camera perspective and raises map events.

Layer visibility can hide `trains`, `stations`, `routes`, `arrows`, and `signals` by default for a city, according to the Subway Builder map reference. That is a render setting, not evidence that hidden entities stop simulating.

### 2. Custom cities are whole-city configurations

The [Custom Cities reference](https://www.subwaybuilder.com/docs/api-reference/cities) lets a mod register a city with one initial latitude/longitude/zoom/bearing and a minimum zoom. `cities.setCityDataFiles(cityCode, ...)` associates a city with a demand dataset, building collision index, roads file, optional airports/ocean-depth data, and optional building tags. Registered cities appear as selections in a dedicated Modded tab or a custom tab.

The [Custom Cities guide](https://www.subwaybuilder.com/docs/guides/custom-cities) likewise describes a custom city as one registration plus one tile endpoint and whole-city demand/building/road assets. It explains that the building index is a packed, spatially bucketed binary to reduce memory overhead, but it is still configured as one city file. No documented API replaces only a geographic slice of the current city's demand, roads, or building index.

This permits a “mega-city” whose tile service covers many logical regions, but it does not establish tile-by-tile simulation loading. It also makes non-render data the likely scaling limit: visual vector tiles can be fetched spatially by the map renderer, while the documented simulation/collision inputs are city-level assets.

The official [Performance & Memory guide](https://www.subwaybuilder.com/docs/guides/performance) states that large maps can exhaust renderer memory, describes V8 heap overrides, and lists renderer OOM, tile-loading failures under memory pressure, and garbage-collection thrashing as common large-map problems. More heap is an escape hatch, not spatial simulation streaming.

### 3. Lifecycle hooks can orchestrate a coarse model, but there is no region lifecycle

The [Lifecycle Hooks reference](https://www.subwaybuilder.com/docs/api-reference/hooks) exposes useful orchestration points:

- `onGameInit`, `onGameLoaded`, `onGameSaved`, and `onGameEnd`;
- `onCityLoad(cityCode)` and `onMapReady(map)`;
- `onHourChange(hour, day)` and `onDayChange(day)`;
- track/station/route/train creation/deletion hooks;
- `onTrainArrivedAtStation(train, station)`;
- pause, speed, money, schedule, demand, warning, and error events.

Hourly and daily hooks are well suited to a mod-owned aggregate simulation. The arrival hook provides observation of active native service, but the docs warn that it can fire extremely often on large networks and recommend aggregating counts and acting on hour/day boundaries.

No published hook corresponds to entering/leaving a geographic tile, camera bounds changing, a simulation chunk loading/unloading, or an entity becoming off-screen. A mod can synthesize region transitions from MapLibre camera events, but those events belong to rendering; it would still have to implement the simulation policy itself.

### 4. Native game state is broadly observable but intentionally read-only

The [Game State reference](https://www.subwaybuilder.com/docs/api-reference/game-state) explicitly calls the namespace read-only. It returns all stations, routes, tracks, and active trains in the current game, plus time, demand, budget, ridership, route financials, and mode-choice statistics. The [Type Reference](https://www.subwaybuilder.com/docs/api-reference/types) exposes detailed plain-object snapshots, including coordinates and identifiers for stations/tracks and motion/route fields for trains.

That is enough to classify entities by a mod-defined region and derive an aggregate off-region state. It is not a native serialization API: mutating getter results is not documented as changing game state, and there is no public setter for a train's exact position/motion/occupancy, a station's full native state, or an arbitrary replacement of the whole network.

The [Build Automation reference](https://www.subwaybuilder.com/docs/api-reference/build) can place and construct blueprint tracks, create/delete routes, purchase trains, spawn a train on a route at a station index, and delete a train. This could support a lossy “despawn and later respawn” experiment. Important gaps remain:

- no documented deletion/unloading operation for constructed tracks or constructed stations;
- no documented bulk import/hydration of a saved network graph;
- no documented restoration of a train between stations with its prior kinematic/passenger/operational state;
- no documented native proxy entity that advances a route without running normal simulation.

Consequently, exact round-tripping of an inactive region is not available through the public build/state APIs.

### 5. Runtime demand is the strongest public lever for an active-region prototype

The [Demand Modification reference](https://www.subwaybuilder.com/docs/api-reference/demand) can add, update, and remove demand points and commuter groups (“pops”) during play. It says these mutations update both the demand visualization and commute simulation, fire `onDemandChange`, and persist in save files. Batched pop updates are documented as handling thousands of changes in a few milliseconds.

This creates a plausible experimental seam:

1. Keep visual geography and constructed infrastructure in one large city.
2. On leaving a logical region, snapshot its demand to mod storage and remove its pops from the native demand model.
3. Advance that region with a coarse hourly/day model owned by the mod.
4. Recreate or update its pops when returning.

This would reduce commuter/pathfinding load attributable to inactive regions, but the public docs do not promise that all derived pathfinding caches, financial history, or in-flight passenger state can be restored exactly. It also leaves tracks, stations, routes, and any retained trains in the global native state. Cross-region journeys are especially difficult because removing one endpoint cascades to its linked pops.

The [Commute Time Customization reference](https://www.subwaybuilder.com/docs/api-reference/pop-timing) can alter global departure windows and demand tiers, but these settings are city/global policies rather than per-region simulation levels.

### 6. Simulation controls are global and do not reduce total native work by region

The [Game Actions reference](https://www.subwaybuilder.com/docs/api-reference/actions) exposes pause/resume and four global speed tiers. `setSpeedMultiplier` modifies the game-time rate for a selected tier.

The [Game Constants reference](https://www.subwaybuilder.com/docs/api-reference/constants) is more revealing:

- the simulation uses fixed 0.5-game-second ticks;
- `RULES.TICKS_PER_UPDATE` globally controls batched train/signal/station ticks, train-coordinate refreshes, pop movement, and pop-movement GeoJSON rebuilds for each speed tier;
- larger batches reduce how often results are handed to rendering, but the documentation explicitly says the simulation performs the same amount of work per game-hour;
- changes apply to the game loop as a whole, and invalid/extreme values are constrained to prevent freezes;
- `GAME_SECONDS_PER_SECOND` changes global passage of time.

There is no documented spatial selector, visibility test, per-route cadence, per-train cadence, or “sleep” flag. These constants can tune global smoothness/overhead and reduce rendering-update frequency, but cannot make only non-visible regions coarse.

### 7. Persistence supports a parallel abstract world, not native chunk snapshots

The [Mod Storage reference](https://www.subwaybuilder.com/docs/api-reference/storage) provides per-mod, Electron-only persistence for JSON-serializable values. It supports asynchronous `get`, `set`, `delete`, and `keys`, with `storage.scoped()` retaining the mod identity across `await`. Storage is global to the mod, so the docs recommend keying per-playthrough data by `gameState.getGameSessionId()`, a stable UUID that survives save/load/rename.

This is enough to store:

- region metadata and activation state;
- aggregate off-region demand, ridership, revenue, expenses, and train counts;
- a mod-owned time cursor and reconciliation data.

It cannot directly store live objects such as functions or DOM nodes, and the public API provides no matching native `restoreWorldChunk` operation. Persistence therefore enables a shadow simulation but does not solve materializing exact native state.

### 8. UI and “commands” are adequate for region travel controls

The [UI Customization reference](https://www.subwaybuilder.com/docs/api-reference/ui) can add toolbar/main-menu/settings buttons, selectors, panels, notifications, and custom React components. A mod could expose a region picker, active-region indicator, loading overlay, or diagnostics panel. The public API does not describe a general console-command registration system; UI callbacks and normal JavaScript event listeners are the documented interaction mechanisms.

The [Development Tools reference](https://www.subwaybuilder.com/docs/api-reference/development) says mods execute as plain JavaScript via `new Function()`, so ES module imports do not work inside the mod script. It nevertheless documents direct `window`, `document`, console, and raw-map use, plus `utils.loadCityData()` for city assets. The public docs do not define a capability/permission manifest or an isolated worker process for simulation code. This makes an in-renderer JavaScript shadow simulation possible, but CPU-heavy work there risks competing with the game's renderer unless undocumented platform capabilities or an external helper are used.

## API-only architecture recommendation

For a public-API proof of concept, use one large custom city and define logical region bounds in the mod:

- MapLibre camera events determine the active region; `flyTo` handles transitions.
- Keep map imagery in vector/raster tiles, which are naturally spatial.
- Begin with off-region **demand/economics only**, advanced on `onHourChange` or `onDayChange` and stored per playthrough.
- Remove/recreate off-region pops experimentally, but leave infrastructure native until profiling shows it is necessary.
- Avoid pretending global `TICKS_PER_UPDATE` is region LOD; treat it only as a global performance tuning knob.
- Instrument correctness around cross-region commuter links, route finances, train inventory, save/load, and returning to a previously active region.

A production-quality version needs at least one deeper engine seam: region-scoped simulation enablement, native chunk serialization/hydration, or a supported way to swap active city/network state without leaving the playthrough. Whether such a seam exists outside the documented API requires bundle inspection and runtime experimentation.

## Installed bundle findings (Subway Builder 1.6.0)

### 1. The critical hidden store/save bridge is reachable by an ordinary mod

The active renderer bundle defines:

- `setStoreCallbacks(...)`, which writes to `globalThis.__subwayBuilder_storeCallbacks__`;
- `getStoreCallbacks()`, which reads that global; and
- a startup microtask that installs `setMoney`, `setTicketCost`, and `getState: () => useMainStore.getState()`.

Evidence: `app.asar :: dist/renderer/public/index-BCLhXOq-.js:164122-164127` and `:203356-203359`.

The mod loader later evaluates each enabled mod with `new Function(...)` in a strict IIFE in the same renderer world (`index-BCLhXOq-.js:220106-220117`). This is not an isolated JavaScript realm, so an ordinary mod can reach the same `globalThis`:

```js
const state = globalThis.__subwayBuilder_storeCallbacks__?.getState?.();
```

The returned object is the live Zustand state **plus its private actions**, including `setTracks`, `setStations`, `setRoutes`, `setTrains`, `setDemandData`, `setTimeConfig`, `generateSave`, `loadSave`, and `handleIncrementGameState`. The bridge is not frozen or proxied. It is a much stronger seam than the documented read-only `gameState` API.

This corrects the API-only conclusion: in the installed 1.6.0 build, a mod can swap a complete active network **without patching the ASAR**. It remains an unsupported internal contract and must be treated as version-fragile.

### 2. `generateSave`/`loadSave` are the safest hidden primitives

`generateSave({name})` produces a full, validated save object containing one `cityCode`, viewport, tracks, trains, routes, time configuration, track groups, signals, station nodes, stations, wallet/fare/financial state, compressed demand, vehicle inventory, station groups, map layer settings, progression data, and other history (`index-BCLhXOq-.js:202979-203000`).

`loadSave(save)` migrates old save versions, validates the object, resets/rebuilds network state and derived data, restores demand and financial/progression state, restores the viewport, and fires the normal game-loaded lifecycle (`index-BCLhXOq-.js:202872-202975`). For tile swapping, this is preferable to manually calling a dozen private setters because the load path rebuilds coupled indices and visualization data.

Important caveats:

- `loadSave` was designed for user save loading, not frequent streaming transitions; it performs telemetry, lifecycle, UI, validation, and reconstruction work.
- Loading fires `onGameLoaded`, so the mod needs a transition guard to prevent recursive initialization.
- Compressed-demand restoration is tied to the current city's base demand IDs. A same-city world dataset whose IDs cover every tile is safest; otherwise direct `setDemandData` use or explicit demand reconciliation may be required.
- Some UI state and secondary stores live outside the save object. Round-trip testing must identify and clear stale selections, dialogs, construction previews, and autosave state.

### 3. The game still has one world, one store, and one active simulation

`loadInitialData(cityCode)` resets the singleton Zustand state, then loads the selected city's full demand file into maps, full roads GeoJSON and spatial index, runway data, building index, and ocean-depth index before firing the city-load hook (`index-BCLhXOq-.js:203120-203184`). There is no built-in collection of live city/tile states and no chunk lifecycle.

The save schema likewise contains one city and one complete network, not a world manifest or tile collection. The hidden bridge makes rapid replacement of that singleton plausible; it does not create simultaneous native worlds.

Static geography is also split unevenly:

- MapLibre/PMTiles basemap data is naturally requested in spatial tiles.
- Demand, roads, collision/building, runway, and ocean-depth inputs are initialized at city scope.

Consequently, a `WORLD` city can stream its visual basemap, but very large non-render datasets may still be the memory ceiling unless the data pack is carefully bounded or the renderer is patched to swap those indices too.

### 4. A simulation worker exists, but it is not a hidden multi-tile engine

The renderer contains a singleton worker wrapper for `simEngine.worker-Bm21lEE0.js`. It allows one tick in flight and sends `{type: 'tick', tickId, syncState, overrides}` (`index-BCLhXOq-.js:201919-201989`). The worker itself keeps one module-global `currentState` and accepts only `patch` and `tick` messages (`simEngine.worker-Bm21lEE0.js:32536-32563`).

More importantly, the current `handleIncrementGameState` hardcodes its worker switch to `false`, so the shipped game calls `updateMultipleGameState` synchronously on the renderer main thread (`index-BCLhXOq-.js:202702-202710`). The compiled worker is therefore an experimental seam, not an enabled off-screen simulator.

Even if a mod or patch spawned additional copies, the native fixed-tick engine would still perform approximately the same work per simulated game-hour for every state. It would move work off the UI thread, not provide the desired low-fidelity inactive model. A custom route/zone aggregate simulation remains the correct performance strategy.

### 5. Other useful—and less useful—undocumented seams

The Electron preload exposes renderer methods for save import/export/autosave/load, city-data discovery, mod discovery, mod storage, and resource paths (`app.asar :: dist/preload/preload.js:42-206`). These may help a prototype store or inspect data, but the generic `electronAPI.invoke(channel, ...)` path checks a small `MOD_ALLOWED_CHANNELS` set and rejects other channels. There is no arbitrary hidden IPC escape hatch.

The main process is substantially harder to modify: `dist/main/main.js` only installs a bytecode loader and imports `main.jsc`. Renderer-side work should therefore prefer the already exposed global store bridge. If a patch eventually becomes necessary, add a narrow compatibility bridge rather than modifying the bytecoded main process.

The renderer also contains a commented built-in `NYC_EXP` entry describing a region from New Brunswick to Poughkeepsie (`index-BCLhXOq-.js:89085-89097`), and the map component applies `minZoom`, `maxZoom`, and pitch but no geographic `maxBounds` (`GameMain-DssiGAu3.js:78574-78578`). These are encouraging clues for a very large contiguous map, but they are not evidence of spatial simulation partitioning.

## Recommended implementation architecture

Use one custom city code, such as `WORLD`, whose MapLibre/PMTiles coverage spans every logical tile. At any instant, Subway Builder contains one detailed active tile; the mod owns the world around it.

Persist these layers of state:

| Layer | Contents | Authority |
| --- | --- | --- |
| World manifest | Tile IDs/bounds/neighbors, gateway pairs, data/schema version | Mod |
| Active tile | Full native save snapshot | Subway Builder while active |
| Inactive tile | Last native snapshot plus route/zone aggregate state | Mod |
| Global ledger | World time, wallet/debt policy, inter-tile queues, aggregate statistics, transaction revision | Mod |

An inactive tile should retain route/headway/capacity, zone-to-zone hourly demand, gateway queues, aggregate riders/revenue/costs, reliability, and optionally a per-route phase used to materialize plausible trains. Advance it hourly or lazily to the current world time. Do not attempt to reproduce signal blocks, half-second train physics, every passenger movement, or exact train locations off-screen.

### Transition transaction

1. Detect a boundary/gateway transition with hysteresis.
2. Pause the native game and temporarily block construction, manual saves, and repeat transitions.
3. Call the hidden state's `generateSave` and persist the source tile snapshot under a new revision.
4. Reconcile active-tile money, ridership, expenses, and elapsed time into the global ledger.
5. Advance the destination's aggregate model to authoritative world time.
6. Turn queued inter-tile passengers/trains into destination gateway demand, backlog, inventory, or scheduled-arrival events.
7. Patch the destination snapshot's time and globally authoritative financial fields.
8. Call hidden `loadSave(destinationSnapshot)`.
9. Move the raw MapLibre camera to the destination gateway, clear stale UI state, commit the transaction revision, and resume.

Gateways must be explicit simulation seams. A passenger journey can retain its origin/destination and economic/statistical identity across the seam, and a through service can retain a world-level run ID, but the active native train on the destination side is a rematerialized representative—not literally the same continuously simulated entity.

## Principal engineering risks

- **Update compatibility:** version-gate the hidden global, required methods, save schema, and bundle hash; fail closed to a read-only recovery UI when incompatible.
- **Transition latency:** save generation and load reconstruction may pause for seconds on large tiles. Profile tile-size limits before authoring the world.
- **Crash consistency:** use a journal/two-phase commit so a crash between source save and destination load cannot lose the active tile.
- **Autosave/construction races:** transition only from a quiescent paused state and coordinate with autosave/load indicators.
- **Clock and finance double-counting:** designate the mod ledger as authoritative and explicitly rebase tile timestamps and operational charge cursors.
- **Approximation shock:** reconcile queues, capacity, vehicle phase, and financial deltas when a tile changes from aggregate to native simulation.
- **Static-data memory:** world-wide roads/building/ocean indices may remain resident even when only one network tile is active.
- **Cross-tile identity:** namespace native IDs by tile in the world ledger; never assume a save-local train/station ID is globally unique.
- **Competitive modes:** hidden state/save manipulation is unsuitable for daily challenges or leaderboards.
- **Security/coexistence:** any mod can overwrite the unfrozen hidden global. Detect replacement and avoid running with unknown conflicting mods.

## Proof-of-concept plan and go/no-go gates

1. **Documented shell:** register a two-region `WORLD` city, draw tile bounds/gateways, and implement camera transitions plus a deterministic aggregate clock.
2. **Capability probe:** on 1.6.0, verify `__subwayBuilder_storeCallbacks__`, `getState`, `generateSave`, and `loadSave`; compare method signatures and fail safely if missing.
3. **Snapshot round trip:** on a tiny network, generate/load the same snapshot 100 times and compare hashes/counts for tracks, stations, routes, trains, demand, money, and time. Go/no-go: no accumulating drift or memory growth.
4. **Two-tile swap:** keep two small same-city snapshots; pause, save, load, reposition, and resume. Measure median/p95 transition time and stale UI/hook behavior.
5. **Gateway model:** transfer aggregate passengers and a world-level through-run across the boundary, rematerializing only destination-native representatives.
6. **Background model:** add seeded hourly demand/capacity/queue/economic updates. Verify 24 hourly steps and one 24-hour lazy catch-up match within defined tolerances.
7. **Persistence:** add revisioned snapshots, two-phase commits, restart recovery, and intentional crash tests at every transition step.
8. **Soak/update test:** eight tiles, 30 simulated days, rapid switching, app restart, mod hot reload, and a game update compatibility check.

The first decisive experiment is steps 2–4. If two same-city snapshots round-trip reliably and switch within an acceptable loading pause, the project is viable. If they do not, fall back to the public-API “one giant always-live city plus coarse demand” design or ask the developer for three supported endpoints: `exportActiveWorldState`, `replaceActiveWorldState`, and `tickIndependentWorldState`.
