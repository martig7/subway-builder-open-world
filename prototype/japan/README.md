# Japan e-Stat statistical-boundary map

This prototype compiles the 47 official 2020 Census `町丁・字等` statistical-boundary packages published by e-Stat. The source units are dissolved by the two-digit `PREF` code into one GeoJSON feature per prefecture.

The raw downloads are intentionally ignored by Git. Rebuild the map with:

```powershell
python scripts\build_prefecture_boundaries.py `
  --raw-dir raw-data\estat\boundaries `
  --output generated\japan-prefecture-boundaries.geojson `
  --preview generated\japan-prefecture-boundaries.preview.geojson `
  --manifest generated\japan-prefecture-boundaries.manifest.json
```

The source packages use JGD2000 / EPSG:4612. Geometry validity, dissolve, and area calculation use EPSG:6933; the published GeoJSON is EPSG:4326. The result is a statistical-boundary model, not a replacement for a navigable OSM/Depot basemap.

## Japan Open World consumer

`mod/` is the single runnable consumer for all 47 prefectures. Its manifest ID
is `local.japan-open-world`; Tokyo and Kanagawa retain their compatible Tile IDs
inside this World rather than remaining separate save lineages. The catalog is
generated from the rendered prefecture overlay, and a build fails closed until
all selected Tile IDs have complete map and demand packages.

The centralized build entry point is:

```powershell
.\map-creator\scripts\build_japan_artifacts.ps1
```

It downloads the region inputs declared by `worlds/japan/map.json`, runs the
same resumable Depot worker for every requested prefecture, compiles one
national demand ledger, verifies mass and endpoint references, enriches routes,
and builds the consumer. `-Tile JP_PREF_11` limits map work to one Tile Package;
the final mod build remains intentionally blocked until all 47 are ready.

Demand points that fail their source-prefecture boundary audit are never moved
to a boundary edge. Their original coordinates are retained and every affected
cohort is diverted out of native demand into the cross-tile ledger. A point
covered by another rendered prefecture adopts that Tile ID; coastal points with
no rendered owner remain explicit deferred cross-ledger endpoints. This avoids
native building-index snapping and the resulting large demand dots at edges.

## Open-world OD preparation

Observed building-to-building trips are not published by e-Stat. The preparation pipeline therefore keeps the 2020 Census municipality-to-municipality commute/school flow as the observed OD backbone, then uses 250 m Census and 500 m Economic Census mesh totals as constraints when later allocating demand to blocks and building footprints. Run this once to acquire the official raw inputs (they remain ignored by Git):

```powershell
.\scripts\download_od_preparation_data.ps1
```

Use `-ListOnly` first to inspect the exact e-Stat mesh packages, or `-SkipEmploymentMesh` if only origin-side data is wanted. The resulting `raw-data\estat\od\od-preparation.manifest.json` records hashes and source URLs. See [OD-DATA-SOURCES.md](OD-DATA-SOURCES.md) for the distinction between observed municipality OD and synthetic building-level allocation, as well as the separate GSI/PLATEAU building-geometry sources.

e-Stat labels the mesh downloads as CSV, but each downloaded artifact is a ZIP archive containing its tabular text file.
