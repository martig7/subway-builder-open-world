# Centralized Open-World Platform and Map Creator Plan

Status: plan only. This document does not move source files, regenerate data, build a mod, install a mod, or change any Native Save.

Purpose: replace the Kansas City proof-of-concept ownership model and the NEC/Tokyo per-world forks with one central open-world implementation. A new World should require a World Definition, geography, pinned source data, and a supported demand Adapter—not a copied runtime, game entry point, installer, tile server, or map pipeline.

The first national-scale consumer is Japan. Map and Tile Package work must be resumable prefecture by prefecture, while the World catalog and cross-prefecture demand remain globally consistent.

## 1. Outcome and acceptance test

The centralization succeeds when a world author can add a directory under `worlds/`, run the central tools, and obtain a validated runnable mod without editing central source or copying another World.

The acceptance test is intentionally concrete:

1. NEC and Tokyo–Kanagawa build from the same runtime, mod builder, installer, PMTiles server, map pipeline, routing implementation, and validation framework.
2. Their stable manifest IDs, World IDs, Tile IDs, ports, source provenance, and save lineage remain unchanged.
3. A third Japanese prefecture can be added to the Japan World using only geography, source locks, and e-Stat demand inputs.
4. Adding that prefecture requires no new `game-entry.js`, `build-mod.mjs`, `install-mod.mjs`, tile-server script, routing worker, Depot generator, or cohort compiler.
5. The active consumer's generated and installed bundles contain the same platform release marker and the expected World Definition hash.

This is not merely a file move. The central implementation must become a deep module: world authors cross a small interface, while save behavior, navigation, finance isolation, rendering, routing, packaging, installation, and validation stay inside its implementation.

## 2. Current problem

The reusable implementation currently lives under `prototype/kc-two-tile/mod/src`, so production-like consumers import from a proof-of-concept directory. The consumer entry points still duplicate orchestration and accumulate features independently:

| Consumer | `game-entry.js` lines | package-adapter lines | build-script lines |
| --- | ---: | ---: | ---: |
| New York | 837 | 146 | 34 |
| NEC | 1,132 | 466 | 162 |
| Tokyo–Kanagawa | 963 | 146 | 138 |

This creates four forms of drift:

- **Runtime drift:** NEC has durable storage, reload recovery, route-path rendering, render-distance registration, and worker-backed demand evaluation that Tokyo does not receive merely by rebuilding.
- **Build drift:** each consumer owns a near-copy of packaging, installation, PMTiles lifecycle, and worker embedding.
- **Data-pipeline drift:** Voronoi aggregation, Depot orchestration, basemap construction, road enrichment, provenance, and reports have world-specific copies.
- **Identity leakage:** consumer names, global keys, pop prefixes, ports, report names, and embedded constant names are compiled into otherwise reusable implementation.

The deletion test exposes the shallow design: deleting any consumer's orchestration would force hundreds of lines of nearly identical behavior to be recreated. The central module should make that complexity disappear from every World.

## 3. Target ownership and repository layout

Create three top-level ownership areas:

```text
open-world-platform/
  package.json
  contracts/
    world-definition.schema.json
    artifact-set.schema.json
    tile-package.schema.json
    demand-evidence.schema.json
  src/
    runtime/
    adapters/
    ui/
    routing/
    mod-builder/
    installer/
  cli/
  testkit/
  tests/

map-creator/
  pyproject.toml
  src/open_world_map_creator/
    geography/
    sources/
    maps/
    demand/
    routing/
    artifacts/
    runners/
  depot/
  containers/
  tests/
  fixtures/
  data/                 # gitignored default data root
    sources/            # content-addressed source cache
    work/               # resumable stage/checkpoint state
    artifacts/          # immutable Artifact Sets
    logs/

worlds/
  nec-corridor/
    world.json
    geography/
    sources.lock.json
    demand.json
  tokyo-kanagawa/
    world.json
    geography/
    sources.lock.json
    demand.json
  japan/
    world.json
    geography/
      prefectures.geojson
      tile-views.json
    sources.lock.json
    demand.json
```

Ownership rules:

- `open-world-platform` owns all browser runtime and runnable-mod behavior.
- `map-creator` owns source acquisition, geographic processing, map generation, demand compilation, road enrichment, artifact storage, and heavy-compute execution.
- `worlds` owns declarative World Definitions and pinned source references. It contains no copied platform implementation.
- The platform may read contracts and generated Artifact Sets, but it must never import from a particular World.
- The map creator may read a World Definition and its sources, but it must never emit consumer-specific source code.
- A World may select a named, already-supported demand Adapter. It may not inject arbitrary code into the runtime.

Generated runnable mods should be disposable build products. They are not source ownership locations.

## 4. Central module interfaces

### 4.1 Runtime module

The browser-facing external seam should be one operation conceptually equivalent to:

```js
startOpenWorld({ definition, artifacts, subwayBuilderHost })
```

The interface includes the validated World Definition and Artifact Set contracts, host compatibility requirements, startup errors, and disposal behavior. Everything else stays inside the module:

- World identity and Native Save binding;
- durable sidecar storage;
- Tile View navigation and native reload recovery;
- shared rail topology and off-tile simulation;
- Native Ledger isolation and revenue accrual;
- geographic overlay, render distance, and renderer virtualization;
- cross-demand viewer and network projection;
- route-path fetch installation and generated-road workers;
- map stability guards, diagnostics, hot-reload generations, and cleanup.

The generated consumer entry point should be a few lines that loads embedded definition/artifact metadata and calls this interface. No World gets a handwritten orchestration file.

### 4.2 Mod builder and installer module

Expose central commands rather than per-world scripts:

```text
ow-mod build   --world worlds/japan --artifacts <artifact-set>
ow-mod verify  --world worlds/japan --output <dist>
ow-mod install --world worlds/japan --output <dist>
```

The implementation owns:

- esbuild configuration and worker embedding;
- manifest generation;
- embedded world/cross-demand metadata;
- Tile Package staging;
- PMTiles server scripts and health checks;
- verified process ownership before server shutdown;
- safe installation target resolution;
- installed bundle timestamps, hashes, and release-marker checks.

World-specific inputs are values such as manifest ID, display name, Tile IDs, tile-server port, basemap revision, and initial Tile View. They are not forks of the builder.

Build and install remain separate commands. A successful build must never imply that the running game has been updated.

### 4.3 Map Creator module

Give the map creator a small command interface:

```text
ow-map plan    --world worlds/japan [--tile <tile-id>]
ow-map build   --world worlds/japan [--tile <tile-id>] [--runner <profile>]
ow-map verify  --world worlds/japan [--artifact-set <id>]
ow-map publish --world worlds/japan --artifact-set <id>
```

`plan` resolves the stage graph and reports missing/stale inputs without writing. `build` executes only invalidated stages. `verify` is read-only. `publish` atomically promotes a verified staging result to an immutable Artifact Set.

Internally, the map creator may have seams for demand ingestion and compute execution, but those seams do not become part of the world-author interface.

### 4.4 Demand Adapter seam

LODES and e-Stat genuinely vary, so this is a real seam with at least two Adapters:

- `lodes-us`: streams exact or block-level home/work observations plus source-partition totals;
- `estat-japan`: reads home/job marginals and municipality/prefecture OD controls.

Both produce canonical **Demand Evidence**, not final game cohorts. Demand Evidence can represent:

- paired home/work observations;
- home and job marginals;
- aggregate OD controls;
- source totals, rejects, vintages, and conservation expectations.

The central demand implementation—not the Adapter—owns site selection, building anchoring, deterministic IDs, cohort packing, cross-tile ledgers, geometric fallback, road enrichment, package encoding, and validation reports. This prevents every new country from reimplementing the game-facing contract.

Do not create a generic custom-code hook for each World. Add a new Adapter only when a genuinely new source model cannot be expressed by an existing one.

### 4.5 Compute Runner seam

Processing may run in the current process, another local process, a container, a queued worker, or an arbitrary remote location. Execution location and transport are operational choices, not facts about a World.

The Runner interface accepts an immutable run manifest plus declared inputs and returns stage results, logs, and an output manifest. A Runner Adapter owns all location-specific behavior:

- materialize the requested implementation revision, tool locks, inputs, and content-addressed source objects;
- execute the same stage command regardless of location or transport;
- reuse location-local content-addressed caches and resumable work directories;
- record the source revision, World Definition hash, container/tool versions, and command arguments;
- return manifests and validation reports before optional large artifact transfer;
- verify every materialized output hash before publication;
- never delete a cache or work directory as an implicit build step.

Runner profiles are operator configuration, kept outside World Definitions and source locks. A profile may select any Adapter and execution location without changing the World Definition or Artifact Set identity. Credentials and machine-specific paths remain outside the repository.

At minimum, tests must exercise an in-process Adapter and a second Adapter that crosses a process or transport seam. The same fixture run manifest must produce equivalent verified outputs through both, so location cannot hide correctness rules.

## 5. World Definition contract

`world.json` is data, validated by a versioned JSON Schema. It should contain only facts that vary by World.

Required sections:

| Section | Owns |
| --- | --- |
| `identity` | stable World ID, manifest ID, display metadata, compatibility lineage |
| `tileViews` | stable Tile IDs, ownership geometry references, initial cameras, neighbor/corridor relationships |
| `map` | OSM source lock, extraction halos, zoom profile, basemap profile, style revision |
| `demand` | Adapter name, source lock, source interpretation, cohort policy, routing profile |
| `runtime` | initial Tile View, storage namespace, tile-server port, required host capabilities |
| `release` | platform compatibility range and Artifact Set selection policy |

Illustrative shape:

```json
{
  "schemaVersion": 1,
  "identity": {
    "worldId": "japan-open-world",
    "manifestId": "local.japan-open-world",
    "name": "Japan Open World"
  },
  "tileViews": {
    "catalog": "geography/tile-views.json",
    "initialTileId": "<stable-prefecture-tile-id>"
  },
  "map": {
    "sourceLock": "sources.lock.json",
    "profile": "osm-depot-world-v1"
  },
  "demand": {
    "adapter": "estat-japan",
    "definition": "demand.json",
    "routingProfile": "generated-roads-v1"
  },
  "runtime": {
    "tileServerPort": 8801
  }
}
```

The final schema must use real locked identifiers; the example deliberately does not choose Japan's initial Tile ID or port.

Avoid a broad `featureFlags` object. Platform fixes and standard capabilities should reach every World automatically. Configuration is appropriate only where behavior is inherently geographic or source-specific.

## 6. Artifact contracts and centralized data storage

Every build produces an immutable Artifact Set with this logical structure:

```text
artifacts/<world-id>/<artifact-set-id>/
  artifact-set.json
  catalog/
    tile-catalog.json
    coverage.geojson
  world/
    cross-demand.json.gz
    cross-commutes.json
    overlays/
  tiles/<tile-id>/
    tile-package.json
    demand_data.json.gz
    buildings_index.bin.gz
    roads.geojson.gz
    runways_taxiways.geojson.gz
    tiles.pmtiles
  reports/
    sources.json
    conservation.json
    road-routing.json
    reproducibility.json
```

`artifact-set.json` records:

- World Definition hash and platform/map-creator revisions;
- source lock hashes and acquisition timestamps;
- all Tile Package hashes and capabilities;
- map/container/tool versions;
- demand and routing model versions;
- validation gate results;
- parent Artifact Set when an incremental build reuses unchanged packages.

Large binaries and raw sources remain outside Git. Commit schemas, World Definitions, source locks, small reports, and test fixtures. The default `map-creator/data` root should be gitignored, and operators may redirect it to a non-OneDrive disk without changing paths embedded in manifests.

Source storage should be content-addressed by SHA-256. A state or prefecture build references shared source objects rather than copying the same OSM, Natural Earth, census, or e-Stat file into each World directory.

Publication is atomic: stages write under `work/<run-id>`, validation runs there, and only a passing result receives an Artifact Set ID. There is no mutable `latest` directory as an input to a reproducible build.

## 7. Map Creator stage graph

The central pipeline is a dependency graph, not a monolithic script:

```text
World Definition + source locks
              |
              v
      validate / acquire
        /             \
       v               v
 geography catalog   normalized Demand Evidence
       |               |
       v               v
 OSM/Depot assets    sites / cohorts / world ledger
       \               /
        v             v
       generated-road enrichment
                  |
                  v
        Tile Packages + reports
                  |
                  v
       verify -> publish Artifact Set
```

Stages and gates:

1. **Definition validation:** schema, stable IDs, unique Tile IDs, source-lock completeness, path containment, and supported Adapter/profile versions.
2. **Acquisition:** hash-pinned downloads or prepositioned source discovery; no downstream stage sees an unverified source.
3. **Geography compilation:** authoritative ownership geometry, display geometry, extraction envelopes, halos, initial cameras, and neighbor/routing corridors.
4. **Map generation:** OSM building index, roads, runways/taxiways, city-detail PMTiles, and unified low-zoom basemap.
5. **Demand normalization:** Adapter output plus exact source conservation ledgers.
6. **Site and cohort compilation:** building anchoring, deterministic aggregation, capacity ranges, local demand, and one canonical world-level cross-tile ledger.
7. **Road enrichment:** one central generated-road graph implementation and profile, checkpointed per Tile Package and directed tile pair.
8. **Packaging:** deterministic compression, hashes, Tile Package manifests, and Artifact Set assembly.
9. **Verification:** schema, mass, topology, coverage, routing, hash, memory, and reproducibility gates.
10. **Publication:** atomic promotion only after all required gates pass.

Each stage key is a hash of its implementation version, normalized inputs, and relevant configuration. Editing UI code must not invalidate Depot. Editing a routing speed profile must not rebuild buildings or PMTiles. Adding one prefecture should not rebuild 46 unchanged prefectures.

## 8. Japan prefecture-by-prefecture model

Treat Japan as one World unless product requirements explicitly call for separate save lineages. Prefectures are incremental Tile Views and Tile Packages, not independent mods.

### 8.1 Stable national catalog

- Use stable IDs derived from locked Japanese prefecture codes and names.
- Freeze the national Tile ID convention before the first published Japan Artifact Set.
- Keep prefecture ownership geometry separate from map extraction envelopes and display overlays.
- Generate the complete 47-prefecture catalog and neighbor graph early, even while only a subset has ready Tile Packages.
- Mark package readiness explicitly; never register an unavailable Tile View as playable.

### 8.2 Incremental map work

Allow commands such as:

```text
ow-map build --world worlds/japan --tile <prefecture-id> --runner <profile>
```

The build may reuse national low-zoom assets, shared Kanto/Tohoku/etc. OSM extracts, administrative boundaries, and source caches. It publishes a new Artifact Set that references unchanged Tile Packages and replaces only the selected prefecture plus affected world-level indexes.

### 8.3 National demand consistency

Prefecture-local map generation can be independent; demand interpretation cannot be fully independent. Cross-prefecture commuters must be represented once in a national ledger.

The e-Stat Adapter should therefore:

1. normalize national home/job marginals and OD controls once;
2. assign every endpoint to a stable prefecture Tile ID or an explicit outside/deferred category;
3. conserve national, prefecture, and directed prefecture-pair totals;
4. emit local cohorts into each Tile Package;
5. emit cross-prefecture cohorts once into the world-level ledger;
6. regenerate only the affected indexes when a newly ready prefecture changes deferred flows into playable flows.

A prefecture package is not “demand complete” merely because its local marginals exist. Its report must state whether inbound/outbound national OD coverage is complete.

### 8.4 Remote islands and discontinuous geography

Tokyo already demonstrates that a single rectangular mainland extraction cannot represent remote islands economically. National support needs an explicit separation between player-visible Tile Views and resumable map-build shards.

- A prefecture Tile View may be assembled from multiple discontinuous build shards when PMTiles and road-graph merging preserve sparse geography correctly.
- Shards have no save identity and never become World IDs.
- If sparse merging is not validated, remote island groups must become explicit Tile Views rather than silently disappearing.
- Tokyo, Okinawa, Kagoshima, Nagasaki, and other discontinuous prefectures are mandatory acceptance cases before claiming all-Japan support.

The map creator owns shard planning and assembly. World authors provide geometry and policy; they do not write a special island pipeline.

### 8.5 Routing corridors

Geographic adjacency and routable road connectivity are different facts. The catalog should store both:

- display/navigation neighbors for the world UI;
- routing corridors for generated-road path construction.

Bridges, tunnels, ferries, and disconnected islands need explicit, validated routing treatment. The renderer may fall back geometrically, but demand reports must distinguish road-routed, modeled, ferry/deferred, disconnected, and geometric-fallback cohorts.

## 9. Migration sequence

### Phase 0 — Freeze behavior and identities

1. Record manifest IDs, World IDs, Tile IDs, storage namespaces, ports, pop-ID prefixes, basemap revisions, source locks, and installed paths for KC, New York, NEC, and Tokyo.
2. Capture golden Artifact Set fixtures from NEC and Tokyo with counts, hashes where deterministic, schemas, routing summaries, and selected runtime diagnostics.
3. Add contract tests for Native Save authority, finance blindness, Tile View transitions, hot reload, route paths, and PMTiles health.
4. Do not rename existing identities during centralization.

Stop if current behavior cannot be described through observable tests. Extraction without a behavioral baseline will only centralize unknown drift.

### Phase 1 — Establish contracts and skeletons

1. Create `open-world-platform`, `map-creator`, and `worlds`.
2. Write and test the four versioned schemas.
3. Create NEC and Tokyo World Definitions by translating existing constants without changing values.
4. Add tiny fixture Worlds that cover one tile, two tiles, cross demand, disconnected roads, and a discontinuous polygon.
5. Extend `.gitignore` for the centralized source cache, work directories, Artifact Sets, and logs.

### Phase 2 — Extract the runtime module

1. Use NEC as the feature-complete behavioral baseline.
2. Move reusable KC implementation and NEC-only improvements behind `startOpenWorld`.
3. Replace consumer-specific globals, prefixes, diagnostics names, and ports with validated definition-derived namespaces.
4. Move the package Adapter, demand evaluator worker, route worker/controller, storage setup, navigation recovery, and UI registration inside the central implementation.
5. Generate a minimal NEC entry point and pass the Phase 0 runtime tests.
6. Generate the Tokyo entry point from its definition; do not patch a Tokyo copy.

Tests should cross the new runtime interface. Once behavior is covered there, delete superseded copy-specific tests rather than maintaining layered suites for dead orchestration.

### Phase 3 — Extract mod building and installation

1. Centralize esbuild, worker embedding, manifest generation, package staging, and source maps.
2. Centralize the PMTiles server and ownership-verified shutdown logic.
3. Make `build`, `verify`, and `install` consume only a World Definition and Artifact Set.
4. Add temporary-directory integration tests for safe target resolution, file completeness, markers, timestamps, and health probes.
5. Preserve explicit install/reload requirements.

### Phase 4 — Create the centralized Map Creator

Extract in dependency order:

1. schemas, hashing, deterministic JSON/gzip, reports, and artifact publication;
2. geographic catalogs, ownership assignment, halos, overlays, and shard planning;
3. source acquisition and content-addressed storage;
4. common Depot invocation and generated-asset validation;
5. unified low-zoom basemaps and PMTiles probes;
6. deterministic building-seed selection and Voronoi aggregation;
7. cohort packing and world-level cross-demand encoding;
8. generated-road routing and on-demand route asset contracts;
9. location-independent Runner interfaces plus in-process and external-execution Adapters.

Start by moving the already-proven NEC implementation, then generalize only facts that differ in the Tokyo Adapter/Definition. Do not build a framework from hypothetical country requirements.

### Phase 5 — Implement source Adapters

1. Implement `lodes-us` from NEC/New York acquisition and inventory behavior.
2. Implement `estat-japan` from the current Tokyo/Kanagawa preparation, marginals, OD controls, and building anchoring.
3. Run both against common Demand Evidence contract tests.
4. Require source-specific conservation reports in addition to common game-package validation.

### Phase 6 — Migrate reference Worlds

Migrate in this order:

1. **NEC:** broadest runtime and routing feature coverage; prove platform completeness.
2. **Tokyo–Kanagawa:** prove a different demand Adapter, CRS/geography shape, two-tile catalog, and port.
3. **New York:** prove older consumer compatibility and remove remaining recovery/build assumptions.
4. **Kansas City:** retain only as a small fixture World if it still provides unique test value.

For each migration: run relevant shared and Adapter tests, build the selected consumer, verify a unique platform marker in `dist/index.js`, install that exact consumer, verify the installed marker/timestamp, check its PMTiles health endpoint, reload the game, reset diagnostics, and reproduce a Tile View transition.

### Phase 7 — Delete legacy ownership

Delete the old ownership only after all migrated Worlds pass:

- no consumer imports from `prototype/kc-two-tile/mod/src`;
- no per-world copies of runtime modules, workers, package Adapters, installers, or tile servers;
- no per-world Depot or road-enrichment implementation where configuration or an Adapter suffices;
- no active build reads a mutable `prototype/*/generated` directory as its source of truth.

Keep compatibility redirects only if an external workflow still calls an old command, and give each redirect a removal date. Never maintain two writable implementations.

### Phase 8 — Expand Japan

1. Freeze the 47-prefecture catalog and national source locks.
2. Migrate Tokyo/Kanagawa into the Japan World without changing their validated data interpretation.
3. Add one new prefecture using only World Definition/geography/demand data; treat any required platform edit as a failed interface test.
4. Build in regional batches through any suitable Runner profile, but publish prefecture-ready Artifact Sets independently.
5. Complete remote-island and national cross-demand acceptance cases.
6. Continue until all 47 Tile Packages pass map, demand, routing, reproducibility, and runtime gates.

## 10. Verification matrix

| Area | Required proof |
| --- | --- |
| Definition | schema valid; stable IDs unique; referenced sources exist and hash correctly |
| Geography | ownership complete/non-overlapping by policy; display topology valid; islands accounted for |
| Map | required assets nonempty; PMTiles probes pass at local and wide zooms; provenance recorded |
| Demand | source totals conserved; local and cross ledgers mutually exclusive; directed pair totals reconcile |
| Routing | graph version/speeds recorded; route/fallback classes counted; enriched package hashes refreshed |
| Reproducibility | identical normalized inputs produce identical IDs, JSON/gzip, manifests, and hashes |
| Runtime | same platform feature set for every World; no handwritten consumer orchestration |
| Save/finance | Native Save and Native Ledger remain authoritative; World Record contains neither topology nor finance |
| Build | consumer bundle embeds definition/artifact/platform markers and all required workers |
| Install | exact manifest target replaced safely; installed hash/timestamp/marker match build |
| Services | expected PMTiles version responds on the configured port; process ownership is verified |
| Game | bundle reload confirmed; clean diagnostics demonstrate new behavior from probe 1 |

## 11. Risks and controls

- **A shared-utilities folder instead of a deep module:** reject interfaces that force each World to recreate startup order or lifecycle rules.
- **Configuration becoming code:** keep the schema narrow; named profiles and Adapters are preferable to arbitrary callbacks and feature flags.
- **National data volume:** use content-addressed caches, resumable stage keys, partitioned demand evidence, and location-independent Runners; never make all-Japan an in-memory single-machine prerequisite.
- **OneDrive duplication and lock contention:** keep heavy data under a configurable map-creator data root and commit only reproducibility metadata.
- **Schema evolution:** version every contract and provide explicit migrations; never reinterpret an old Artifact Set silently.
- **Save lineage breakage:** preserve existing manifest, World, Tile, storage, and pop IDs during migration; test old saves before retiring consumer code.
- **Incomplete prefecture demand presented as complete:** publish coverage status and deferred inbound/outbound mass in every report.
- **Remote islands omitted by rectangular assumptions:** require discontinuous-geography fixtures and named Japan acceptance prefectures.
- **Execution-location divergence:** execute the same run manifest and container/tool locks through every Runner Adapter.
- **Stale installed bundles:** retain build/install separation and verify unique markers in source, `dist`, installed bundle, and runtime diagnostics.

## 12. First implementation slice

The first slice should prove the architecture without attempting all of Japan:

1. Add the directories and contracts.
2. Translate NEC and Tokyo constants into World Definitions.
3. Extract a central `startOpenWorld` using NEC behavior as the baseline.
4. Generate and test NEC and Tokyo entry points from definitions.
5. Centralize the mod builder, worker embedding, installer, and PMTiles server.
6. Extract generated-road enrichment into `map-creator` and run Tokyo enrichment through a non-in-process Runner profile.
7. Publish NEC and Tokyo Artifact Sets through the new artifact contract.
8. Build, install, reload, and diagnose both consumers.
9. Add one new Japanese prefecture without editing platform or map-creator implementation.

Only after step 9 succeeds should the project begin bulk 47-prefecture generation. That step is the strongest evidence that the interfaces are deep enough and that a new World/Tile Package is truly data-driven.

## 13. Definition of done

Centralization is complete when:

- `open-world-platform` is the only owner of runtime and runnable-mod behavior;
- `map-creator` is the only owner of map/demand/routing processing and generated data storage;
- `worlds/*` contains declarative definitions, geography, demand configuration, and source locks only;
- NEC, Tokyo–Kanagawa, and New York have feature parity through the same platform release;
- every Runner Adapter uses the same stage graph and run manifest;
- Artifact Sets are immutable, reproducible, hash-verified, and installable;
- a new prefecture can be added without copying or editing implementation;
- the active consumer—not KC as a proxy—is built, installed, reloaded, and verified;
- legacy KC ownership and per-world implementation copies are removed.
