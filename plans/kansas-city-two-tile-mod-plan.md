# Kansas City two-tile open-world mod implementation plan

Status: offline prototype implemented; live-game and production map-data validation pending  
Date: 2026-08-10  
Prototype purpose: determine whether Subway Builder can safely swap detailed regional state while preserving a coherent world clock, economy, network snapshots, and cross-tile commuter demand.

Implementation: see [`prototype/kc-two-tile/README.md`](../prototype/kc-two-tile/README.md). The fixture compiler, transactional runtime, installable mod bundle, schemas, logic lab, and offline tests are complete. Depot/Overture map generation and the 100-transition live 1.6.0 soak test remain go/no-go experiments.

## 1. Decision summary

Build two adjacent **25 km × 25 km ownership tiles** divided by the Kansas–Missouri state line, with a **2 km immutable-data halo** around each tile.

Approximate discovery bounds, to be replaced by exact EPSG:26915 polygons during the first pipeline milestone:

| Tile | Approximate WGS84 ownership bounds | Source states |
| --- | --- | --- |
| `KCW` — Kansas City West | `[-94.8955, 38.8875, -94.6070, 39.1125]` | Kansas, plus Missouri halo data |
| `KCE` — Kansas City East | `[-94.6070, 38.8875, -94.3185, 39.1125]` | Missouri, plus Kansas halo data |

The ownership polygons must not overlap. Halos may overlap and duplicate immutable roads, buildings, and visual features, but must never duplicate ownership of demand, player-built infrastructure, money, or simulation events.

Use 2023 LODES `JT01` Primary Jobs for Kansas and Missouri. Retain both `main` and `aux` OD files so cross-state commuters are represented. Use one corridor-wide PMTiles visual archive initially; demand, collision geometry, roads, and native game state are tile-scoped.

## 2. Prototype questions

The prototype succeeds only if it answers all of these questions with measurements:

1. Can the installed game load two independently generated city-data packages in one play session?
2. Can a mod snapshot the active tile, switch its static assets, and restore the destination tile without corrupting coupled game state?
3. Can one global clock, wallet, and fare policy remain authoritative across both tile snapshots?
4. Can local and cross-tile LODES cohorts be conserved without duplicate commuters or jobs?
5. Can the inactive tile advance through a deterministic aggregate simulation and reconcile when reactivated?
6. Can a player build network segments terminating at gateways and later recover equivalent service on the other tile?
7. Are load time, memory, and repeated-transition stability good enough to justify a larger regional prototype?

The first implementation should optimize for observability and correctness, not seamless presentation. Explicit `Switch West` and `Switch East` controls are preferable to an automatic camera-triggered transition until state swapping is proven reliable.

## 3. Capacity limits and go/no-go criteria

Tile size is subordinate to an entity and memory budget. Run a preflight after demand and map generation; subdivide a tile into 12.5 km children if it exceeds a hard limit.

### Per-tile build limits

| Metric | Target | Hard stop for the 25 km tile |
| --- | ---: | ---: |
| Final demand cohorts (`pops`) | 60,000–250,000 | 750,000 |
| Compact demand JSON | ≤ 50 MB | 150 MB |
| Expanded building collision index | ≤ 250 MiB | 500 MiB |
| Compressed roads asset | ≤ 100 MiB | 250 MiB |
| Active + prefetched demand heap | ≤ 500 MiB | 1 GiB |

### Runtime acceptance criteria

- First functional transition completes in **≤ 5 seconds** on the development machine.
- Optimization target is **≤ 2 seconds**; **≤ 500 ms** is a stretch goal, not a prototype gate.
- Renderer working-set growth settles after repeated swaps and does not climb monotonically.
- One hundred alternating transitions preserve counts and identifiers with no accumulated drift.
- World time and wallet change exactly once per event and never rewind when loading an older tile snapshot.
- Cross-tile worker mass is conserved exactly at the compiled-cohort level.
- A 30-game-day deterministic run gives the same inactive-tile result whether advanced hour by hour or caught up lazily on activation.
- A forced interruption at every transition phase recovers either the old committed tile or the new committed tile, never a half-written world.

Failure to meet a hard limit triggers subdivision or a narrower prototype. Failure of state round-tripping or static-asset replacement is a no-go for an ordinary mod and redirects the project toward an explicit game patch or developer-supported loader interface.

## 4. Architecture and seams

The central module is `WorldTileRuntime`. It hides game-specific state mutation, transaction ordering, inactive simulation, and gateway reconciliation behind a small interface:

```ts
interface WorldTileRuntime {
  boot(worldId: string): Promise<WorldView>;
  transitionTo(tileId: TileId): Promise<TransitionResult>;
  advanceTo(worldTime: GameTime): Promise<WorldView>;
  checkpoint(reason: CheckpointReason): Promise<CheckpointResult>;
}
```

Callers must not manipulate game saves, tile ledgers, or demand objects directly. The interface guarantees:

- one committed active tile;
- one authoritative world clock and wallet;
- idempotent transition transaction IDs;
- monotonic per-tile revision numbers;
- conserved cross-tile commuter cohorts;
- validated tile packages before game-state mutation;
- rollback to the previous committed state on failure.

### Required adapters

`WorldTileRuntime` has three real seams because each has at least two useful adapters:

1. **Game adapter**
   - `SubwayBuilderGameAdapter`: wraps the installed v1.6.0 hidden store callbacks and normal mod interface.
   - `FakeGameAdapter`: an in-memory implementation for state-machine, corruption, and crash-recovery tests.

2. **Tile package adapter**
   - `HttpTilePackageAdapter`: loads versioned static assets from a local HTTP host with checksums.
   - `MemoryTilePackageAdapter`: serves tiny fixtures to tests and the logic prototype.

3. **World-state adapter**
   - `ModStorageWorldStateAdapter`: sufficient for the two-tile proof of concept and small JSON ledgers.
   - `SqliteWorldStateAdapter`: target for the national architecture, implemented through a small local companion host if the mod cannot safely access SQLite itself.

Do not spread direct calls to `globalThis.__subwayBuilder_storeCallbacks__` throughout the mod. The game adapter is the only place allowed to know about the unsupported global or save-object field layout. It must refuse to run when the game version or capability probe does not match.

## 5. World model

### Immutable world data

- Tile catalog, ownership polygons, and halos.
- Stable demand-point and cohort IDs.
- Per-tile local demand.
- Cross-tile cohort definitions.
- Gateway assignments and baseline travel costs.
- Roads, building collision data, PMTiles, labels, and optional airport geometry.
- Schema version, data vintage, source checksums, and compiler version.

### Mutable world data

- Authoritative world time, speed, wallet, fares, debts, and global settings.
- Active tile ID and transition transaction.
- One native snapshot per tile.
- Per-tile last-simulated time and aggregate financial/ridership state.
- Gateway departure, in-transit, arrival, and backlog queues.
- Cross-tile service definitions and route phases.
- Player-created gateway connections.
- Monotonic world and tile revision numbers.

### Cross-tile demand representation

Each compiled LODES relationship has one canonical owner and classification:

- `LOCAL`: both endpoints in the same tile; materialize as an ordinary native pop.
- `OUTBOUND`: residence is local and job is remote; replace the remote job with a local gateway proxy while that residence tile is active.
- `INBOUND`: residence is remote and job is local; replace the remote residence with a local gateway proxy while that job tile is active.
- `EXTERNAL`: neither endpoint is active; keep only in the aggregate world model.

The same global cohort ID links its west-side and east-side projections. A projection is a view of one cohort, not a second cohort. This invariant prevents double-counting.

Begin with three fixed gateway anchors along the shared border—north, central, and south. Assign each cross-tile cohort to the least-cost gateway during compilation. The first version may use road travel time; later versions can recompute gateway choice from player-built transit service.

## 6. Repository layout to create

```text
prototype/kc-two-tile/
  README.md
  mod/
    package.json
    src/
      index.ts
      world-tile-runtime.ts
      world-model.ts
      adapters/
        subway-builder-game-adapter.ts
        fake-game-adapter.ts
        http-tile-package-adapter.ts
        memory-tile-package-adapter.ts
        mod-storage-world-state-adapter.ts
      ui/
        prototype-panel.ts
    fixtures/
  pipeline/
    pyproject.toml
    config/
      world.yaml
      tiles.geojson
      gateways.geojson
      sources.lock.json
    src/kc_world_builder/
      acquire.py
      normalize_lodes.py
      compile_demand.py
      compile_gateways.py
      build_maps.py
      validate.py
      package.py
    tests/
  schemas/
    tile-manifest.schema.json
    world-state.schema.json
    gateway-ledger.schema.json
  artifacts/                 # generated and ignored
  raw-data/                  # downloaded and ignored
  benchmark-results/         # retained summaries, not raw data
```

The prototype must be clearly labeled throwaway. Validated interfaces and invariants can later move into production modules; generated data and implementation shortcuts should not silently become the national pipeline.

## 7. Data harvesting and map-generation workstream

### D0. Pin inputs and create the build manifest

- Record exact URLs, bytes, SHA-256, release vintage, license/attribution, and retrieval timestamp.
- Pin the Depot and U.S. demand-generator commits.
- Define the final two 25,000 m ownership squares and 2,000 m halos in EPSG:26915, then export WGS84 GeoJSON for other tools.
- Assign stable IDs to tiles and gateways.
- Make every generated artifact content-addressed or include a build hash in its manifest.

Deliverable: `sources.lock.json`, exact `tiles.geojson`, exact `gateways.geojson`, and an empty reproducible build directory.

### D1. Acquire the minimum source data

- Census LODES8 Kansas and Missouri crosswalk files.
- Kansas and Missouri 2023 `od_main_JT01` and `od_aux_JT01` files.
- Optional WAC/RAC `S000/JT01` validation files.
- Kansas and Missouri OSM PBF extracts, or a single clipped metro extract.
- Overture building partitions intersecting each halo.
- Any label, landcover, or bathymetry inputs required by Depot.

Keep source gzip/PBF/Parquet files immutable. Verify hashes before each build. Do not commit raw data.

### D2. Normalize LODES out of core

- Stream OD rows; preserve 15-digit block codes as fixed strings or validated unsigned integers with zero-padding on output.
- Retain only workplace block, residence block, `S000`, source state, source file kind, and source vintage for the prototype.
- Read only necessary crosswalk columns: block code, latitude, longitude, and optional county/tract identifiers.
- Assign each endpoint to exactly one ownership tile, halo-only, or outside-corridor classification.
- Write partitioned Parquet for reproducibility and debugging; never construct the entire OD set as Python dictionaries.
- Validate workplace totals against WAC and residence totals against RAC where coverage rules permit.

Deliverable: canonical corridor `blocks.parquet` and `od.parquet`, plus a conservation report.

### D3. Compile local and cross-tile demand

- Aggregate identical or near-identical block pairs according to a versioned clustering configuration.
- Apply the same maximum cohort size used by the game-facing demand format.
- Compile `LOCAL`, `OUTBOUND`, `INBOUND`, and `EXTERNAL` classifications.
- Assign cross-tile cohorts to one of the three gateways.
- Calculate driving seconds/distance on the full two-tile corridor using a local OSRM graph; avoid OSMnx whole-graph objects in each worker.
- Do not generate `drivingPath` nationally or for inactive trips. Include detailed paths only if a later active-tile experiment proves they are required.
- Produce both packed runtime data and conventional demand JSON fixtures so the size and heap tradeoff can be measured.

Deliverables per tile:

- `demand_data.json.gz` for the initial game load;
- `nodes.bin`, `trips.bin`, and `gates.bin` for the experimental runtime;
- counts and byte-size report by cohort class and gateway.

### D4. Generate map assets per halo

- Fork or wrap Depot so each tile is built independently from its halo polygon.
- Use EPSG:26915 for metric filtering/simplification.
- Build one corridor-wide visual PMTiles archive so panning across the seam is visually continuous.
- Build tile-scoped `buildings_index.bin.gz`, `roads.geojson.gz`, and runway/taxiway assets from the halo.
- Disable ocean foundations for the Kansas City prototype.
- Initially disable building foundations if they materially increase build time or archive size; collision footprints are the required capability.
- Replace Depot stages that call whole-file `json.load`, `fetchall`, or full-dataframe conversion if either tile exceeds the memory thresholds.
- Clip ownership-sensitive output consistently and document duplicated halo geometry.

Deliverable: complete `KCW` and `KCE` city-data packages plus shared corridor PMTiles.

### D5. Validate and package

- Run Subway Builder's exposed schemas and binary building-index validator.
- Check every local pop endpoint exists in the tile demand points.
- Check every cross-tile global cohort has exactly the expected west/east projections.
- Check local totals + gateway totals reconstruct the canonical OD totals.
- Check ownership polygons have no gap/overlap and every immutable halo feature has stable provenance.
- Emit a manifest containing counts, uncompressed/compressed sizes, hashes, schema versions, and source vintages.
- Serve artifacts from a minimal local HTTP host with CORS and byte-range support.

Go/no-go gate: both packages pass validation and remain below the per-tile hard limits before mod integration begins.

## 8. Mod/runtime implementation workstream

### M0. Capability and save-round-trip spike

- Scaffold the smallest loadable mod and a diagnostic panel.
- Probe the documented interface and hidden `__subwayBuilder_storeCallbacks__` seam.
- Record game version and capability results; disable the prototype rather than guessing on mismatch.
- On a tiny throwaway network, call the wrapped save generator and loader 100 times.
- Compare normalized hashes and counts for tracks, stations, routes, trains, demand, money, time, and settings.
- Measure latency and renderer working-set drift.

Go/no-go gate: no semantic drift, no monotonic memory leak, and a documented safe call order.

### M1. Register and load two static tile packages

- Register `KCW` and `KCE` as prototype city codes while presenting them as one world in the mod panel.
- Point both at the shared corridor PMTiles visual source.
- Configure their distinct demand, road, and collision assets.
- Load each independently and record time-to-map-ready, time-to-demand-ready, peak memory, and validation errors.
- Confirm the camera can be restored to equivalent coordinates and zoom after switching.

Go/no-go gate: both cities load reliably in one process without restarting Subway Builder.

### M2. Implement `WorldTileRuntime` with fake adapters first

- Implement the transition state machine against `FakeGameAdapter` and in-memory fixtures.
- Surface the complete relevant state in a throwaway single-file logic prototype: active tile, revisions, clock, wallet, gateway queues, snapshots, and transaction phase.
- Exercise successful swaps, duplicate requests, stale snapshots, corrupt packages, interrupted transitions, and lazy inactive catch-up.
- Keep all state in memory for this stage.

Transition phases:

1. acquire transition lease;
2. pause game and quiesce hooks/autosave;
3. generate and validate active snapshot;
4. reconcile active results into the world ledger;
5. advance destination aggregate state to world time;
6. prepare destination package and projected gateway demand;
7. load destination static data and native snapshot;
8. overwrite snapshot-local clock/wallet with authoritative global values;
9. restore camera/UI and verify counts;
10. atomically commit active tile and revisions;
11. resume game and release lease.

### M3. Integrate real tile switching

- Implement `SubwayBuilderGameAdapter` as the only module that touches hidden store actions.
- Determine whether city/static-data loading followed by `loadSave` is sufficient; do not manually call many unrelated setters unless unavoidable.
- Suspend mod hooks during controlled load operations so late-fire hooks and demand changes do not recurse.
- Namespace tile-local IDs and preserve global gateway IDs.
- Add explicit West/East switch buttons, progress display, diagnostics, and rollback error reporting.
- Persist two native snapshots and the small world ledger through mod storage.

Go/no-go gate: 100 alternating manual transitions meet integrity criteria and the ≤5-second initial latency limit.

### M4. Implement cross-tile commuter projections

- On activation, materialize local pops normally.
- Replace off-tile endpoints with gateway proxy demand points using the compiler's projection table.
- Record active-leg departures, arrivals, served/abandoned cohorts, and travel-time statistics without changing global cohort mass.
- On deactivation, reconcile native results into gateway queues and the aggregate ledger.
- On destination activation, materialize pending arrivals at the corresponding destination gateway.
- Add diagnostics that trace any global cohort through its active projection and ledger events.

Go/no-go gate: fixture totals remain conserved through a full morning departure, cross-tile arrival, evening return, and multiple tile transitions.

### M5. Implement inactive simulation

- Use a seeded deterministic aggregate model with hourly steps.
- Track, at minimum, departures, arrivals, gateway backlog, generalized travel time, service capacity, ridership, revenue, operating costs, and last-simulated time.
- Advance inactive state on hour changes when cheap, or lazily during transitions.
- Ensure hourly stepping and a multi-hour catch-up produce the same result.
- Keep the inactive model independent of native train physics.

### M6. Prototype network gateway handoff

- Permit player-built tracks to terminate at one of the three gateway anchors.
- Store the relationship between tile-local terminal stations and a global service/gateway ID.
- Convert a departing cross-tile train into a scheduled world event containing service ID, consist, passenger aggregate, departure time, and expected arrival.
- Reconstruct an equivalent train only when its destination tile is active and the destination gateway is valid.
- Clearly label this as statistical/service continuity, not continuous native train physics.

This milestone is valuable but not required to prove cross-tile commuter demand. Complete M4 and M5 first.

### M7. Automatic transition and presentation

- After manual switching is stable, observe MapLibre camera movement and expose an `Enter West/East tile` prompt near the seam.
- Do not switch while the player is dragging, constructing, saving, or during an existing transition.
- Prefetch the neighbor's manifest and compressed demand package.
- Add a short loading overlay and transition diagnostics.
- Automatic switching remains optional for the feasibility verdict.

## 9. Testing and observability

### Data tests

- Source hashes and schema validation.
- OD `main`/`aux` inclusion without duplicates.
- Stable tile ownership for points exactly on the seam.
- WAC/RAC conservation checks.
- Agglomeration determinism for a fixed seed/configuration.
- Stable global cohort and gateway IDs across rebuilds.
- Artifact size regression thresholds.

### Runtime tests

- Transition-state tests through the public `WorldTileRuntime` interface.
- Save normalization and semantic hash comparisons.
- Repeated and concurrent transition request handling.
- Hook-recursion suppression.
- Transaction interruption and recovery at every phase.
- Clock and wallet single-writer invariants.
- Cross-tile departure/arrival/return conservation.
- Inactive hourly-versus-lazy equivalence.
- Corrupt/missing package rejection before mutation.

### Required telemetry

- Transition ID, source/destination tiles, phase, and durations.
- Package byte counts and validation time.
- Native object counts before/after load.
- Process working set and JavaScript heap where available.
- World/tile revisions and snapshot hashes.
- Gateway queue mass and reconciliation deltas.
- Hook invocations suppressed or emitted during transition.

Diagnostics must be exportable as a small JSON report without including Census raw data or enormous game saves.

## 10. Delivery sequence

| Milestone | Principal deliverable | Decision unlocked |
| --- | --- | --- |
| 0 | Exact tiles, pinned sources, schemas, capability probe | Can the project start reproducibly? |
| 1 | Canonical LODES corridor and conservation report | Does 25 km fit the demand budget? |
| 2 | Two validated map/city packages | Does 25 km fit static-data budgets? |
| 3 | Save round-trip and two-city load spike | Is unsupported state swapping viable? |
| 4 | Fake-adapter transition logic prototype | Is the state model correct and recoverable? |
| 5 | Real manual tile switching | Can the renderer survive repeated swaps? |
| 6 | Cross-tile demand and inactive simulation | Does the open-world illusion conserve commuters and time? |
| 7 | Gateway train/service handoff | How much network continuity can be preserved? |
| 8 | Soak test and benchmark report | Proceed, resize tiles, patch the game, or stop? |

Build order must follow the gates. Do not spend time polishing automatic transitions or train reconstruction before static asset switching and commuter conservation have passed.

## 11. Prototype verdict rubric

At the end, record one of four outcomes:

1. **Proceed with 25 km tiles:** all limits pass with headroom.
2. **Proceed with adaptive tiles:** architecture works, but one tile exceeds entity/static-data limits and must subdivide.
3. **Proceed only with a patched loader:** data and state models work, but ordinary mod interfaces cannot replace static/native state safely.
4. **Stop:** repeated state swaps corrupt data, leak unbounded memory, or cannot maintain global invariants.

The desired result is not a polished Kansas City map. It is an evidence-backed decision about whether the national open-world architecture deserves a production implementation.

## Related feasibility evidence

- [Open-world mod feasibility](../research/open-world-mod-feasibility.md)
- [Nationwide LODES/map feasibility](../research/us-lodes-national-map-feasibility.md)
- [Subway Builder custom-city interface](https://www.subwaybuilder.com/docs/api-reference/cities)
- [LODES8 data directory](https://lehd.ces.census.gov/data/lodes/LODES8/)
- [Depot map-generation source](https://github.com/Subway-Builder-Modded/depot)
