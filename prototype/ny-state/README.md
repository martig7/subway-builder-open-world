# New York State feasibility prototype

**PROTOTYPE / THROWAWAY:** this directory freezes and measures the New York grid and LODES inputs, exercises the generalized runtime on fixtures, and builds the six-package density pilot. It does not modify the working Kansas City mod.

The prototype answers four questions:

1. Does the NYC-derived grid reproducibly produce 33 substantive New York tiles and two shoreline slivers?
2. Does every New York LODES crosswalk block resolve to an addressable grid cell?
3. Is all `S000` worker mass conserved while classifying local, cross-tile, and external-inbound flows?
4. Which six tiles should be used for the density pilot before the full Depot build?

Milestone 1 also includes [logic-prototype.html](logic-prototype.html), a self-contained in-memory lab for the 35-tile transition/checkpoint model. Open it directly; no server is required.

## Run

Python 3.11+ and the dependencies in `pyproject.toml` are required.

```powershell
.\run-milestone0.ps1
```

To reuse already-downloaded official files:

```powershell
.\run-milestone0.ps1 -CacheDir C:\path\to\download-cache
```

The command verifies every source against `config/sources.lock.json`, generates the catalog and coverage GeoJSON, streams 7.8 million OD rows, and fails if any frozen count or conservation gate changes.

## Committed outputs

- `generated/catalog/tile-catalog.json` — shared machine-readable grid/catalog contract.
- `generated/catalog/tile-catalog.generated.js` — synchronous mod-registration form.
- `generated/coverage/ny-tile-coverage.geojson` — atlas/QGIS coverage preview.
- `generated/coverage/ny-tile-coverage.svg` — immediately viewable coverage preview.
- `generated/reports/lodes-tile-inventory.json` — complete measurements and pilot selection.
- `generated/reports/lodes-tile-inventory.md` — human-readable gate result.
- `generated/reports/lodes-tile-pairs.csv` — compact home-tile/work-tile partition inventory.
- `generated/reports/runtime-soak.md` — Milestone 1 state-model and real-runtime verdict.
- `generated/fixtures/runtime-fixtures.json` — 35 tiny runtime packages and their shared fixture world.
- `generated/fixtures/tiles/*/manifest.json` — independently addressable fixture manifests.

Raw Census archives remain ignored under `raw-data/`.

## Six-package density pilot

The Milestone 2 build uses real 2023 LODES demand and dated 2026-08-10 Geofabrik OSM extracts. Depot runs one tile at a time with a 16 GiB Docker limit and deletes rebuildable intermediate files after validating each final package.

```powershell
.\build-pilot.ps1
npm run pilot:routing
npm run pilot:benchmark
```

To resume using the existing downloads or completed stages, pass `-SkipDownloads`, `-SkipDemand`, `-SkipDepot`, or `-SkipBenchmarks` to `build-pilot.ps1`. The final commands produce `generated/pilot/reports/pilot-routing.json` and the human-readable `generated/pilot/reports/milestone2-feasibility.md`; large generated packages remain ignored.

## Runtime validation

```powershell
npm run build:logic
npm run soak
```

The soak performs 1,000 deterministic transitions with an invariant check after every switch. It also verifies exact older-save restoration, ten-autosave retention, garbage collection, and preservation of the separately referenced global network.

## Real-game six-tile canary

`mod/` packages the six completed real-data tiles as a separate Subway Builder mod. It deliberately disables the unfinished statewide cross-commute payload so performance measurements cover native demand, buildings, roads, PMTiles rendering, save capture, and tile switching without an incompatible schema affecting the result.

```powershell
cd mod
npm test
npm run build

cd ..
.\tools\start-canary-server.ps1
```

The build reuses the KC prototype's pinned local esbuild installation when this canary has no local `node_modules`, so it can be rebuilt offline. Its installer owns only `%APPDATA%\metro-maker4\mods\ny-state-six-tile-canary` and the six `NY_*` directories under `%APPDATA%\metro-maker4\cities\data`. Keep the PMTiles Docker server running on port 8798 while testing. Stop it with `tools\stop-canary-server.ps1`.

Each served `tiles.pmtiles` is a single continuous native vector source: shared
Natural Earth 10m land, lakes, and country boundaries at
zooms 0–9, followed by that tile's Depot detail at zooms 10–15. Rebuild this splice independently with
`tools\build-unified-basemaps.ps1`; the script retains the original detailed
archive as `tiles.city-only.pmtiles`, verifies every candidate, and checks a
world tile outside the New York footprint at both low and middle zoom before
replacing the served file.

Every completed atlas switch shows its total elapsed time in a game notification. The last 50 measurements—including staging, navigation, completion, and Chromium heap deltas when available—are also exposed as `globalThis.__nyStatePilotDiagnostics__` in DevTools and stored in the mod's scoped storage.

## Frozen decisions

- EPSG:26918.
- origin `(553400, 4483300)` metres.
- ownership cells `77,700 × 97,300` metres.
- half-open ownership boundaries.
- 2 km immutable-data halos.
- more than 1 km² of New York intersection for a normal package.
- demand-site merge distance 100 m, cohort target minimum 50, cohort maximum 200.

See [the statewide plan](../../plans/new-york-state-large-test-plan.md) and [research note](../../research/new-york-state-large-test-research.md) for the rationale.
