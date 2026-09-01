# Tokyo–Kanagawa open-world test

Run the compiler with the bundled Python runtime so its spreadsheet and spatial packages are available:

```powershell
& 'C:\Users\darkd\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' prototype\japan\scripts\build_tokyo_kanagawa_test.py
```

The default is a 350 m NEC-style Voronoi seed radius. It retains 250 m census cells as the source-resolution floor, then produces weighted-centroid demand sites in `generated/tokyo-kanagawa-test/`.

The generated inputs are deliberately statistical, rather than a false building-level O/D model:

- `home-mesh-250m.geojson`: resident work/study demand.
- `job-mesh-500m.geojson`: employment capacity.
- `municipality-od.json`: observed municipal O/D controls, including Tokyo–Kanagawa crossing flows.
- `voronoi-demand-sites.geojson`: final demand points for the test world.

The standalone mod compiler in `../tokyo-kanagawa/scripts/build_world_data.py` performs the map-aware step. It selects a fine irregular candidate field from each Depot building index, applies the NEC maximal-radius merge independently of the statistical lattice, and only then assigns the 250 m home and 500 m job marginals to those building sites. The flow allocator conserves `municipality-od.json` totals while using the statistical meshes as its weights.

## NEC procedure, adapted

The Northeast Corridor build has two independent products that meet only in the mod package:

1. Compile observed O/D plus local demand locations into per-world/tile demand files.
2. Download pinned Geofabrik OSM extracts, then run the pinned Depot Docker image to emit buildings, roads, runways, and PMTiles.
3. Stage both generated products into the game-facing package and validate that every world tile has both manifests.

This test completes step 1 for a single Tokyo–Kanagawa world. The next pass must acquire the Kanto OSM extract and the same Depot image before a navigable basemap can be built. Keep the Tokyo islands as separately streamed world tiles rather than stretching the mainland road package across the ocean.
