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
