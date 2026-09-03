# Tokyo–Kanagawa open world mod

This is a separate two-city Subway Builder mod, adapted from the NEC package contract. It has its own mod ID and save lineage while sharing the Open World PMTiles server on port `8799`. Its city packages are:

- `JP_TOKYO_MAINLAND`
- `JP_KANAGAWA_MAINLAND`

The demand compiler combines two prepared inputs:

- e-Stat 250 m resident demand and municipality O/D controls from `../japan/generated/tokyo-kanagawa-test/`.
- Individual OSM building centers from each Depot `buildings_index.bin.gz` package.

The compiler selects a dense, irregular candidate field from OSM buildings near positive home or employment cells. It applies the NEC deterministic 350 m maximal-radius Voronoi merge first, then assigns the e-Stat home and job marginals to those independent building anchors. This removes the raw census lattice, represents coastal employment centers, and prevents mesh centroids from appearing in open water while conserving the published totals.

Build the Depot map packages first when their building indexes are absent:

```powershell
.\build-tokyo-kanagawa.ps1
```

Then run the demand compiler through a Runner profile with enough memory for the
multi-million-building spatial index:

```powershell
python .\scripts\build_world_data.py
```

Tokyo's far-island cells are reported separately and are not placed in the mainland road map.

Then stage the standalone mod:

```powershell
Push-Location .\mod
npm run build
Pop-Location
```

The Depot phase uses the same OSM-only building extraction and generated-asset checks as NEC. `npm run build` intentionally fails until both prefecture map packages contain the required Depot assets.

## Prefecture overlay

The visual Tokyo/Kanagawa overlay is a topology-preserving union of OSM
`admin_level=7` municipality boundaries, keyed by their Japanese local-government
codes. It is separate from the e-Stat geometry used for demand assignment because
the statistical-area dissolve contains overlapping coverage that is unsuitable
for a selectable map overlay.

Extract the administrative relations from the same Kanto PBF with the pinned
Depot image, export them as GeoJSON, then compile the small browser artifact:

```powershell
docker run --rm --volume "${PWD}:/work" kc-two-tile-depot:ef4ab40 `
  osmium tags-filter /work/raw-data/osm/kanto-latest.osm.pbf r/admin_level=4 `
  -o /work/generated/prefecture-admin-level4.osm.pbf --overwrite

docker run --rm --volume "${PWD}:/work" kc-two-tile-depot:ef4ab40 `
  osmium export /work/generated/prefecture-admin-level4.osm.pbf `
  --geometry-types=polygon -f geojson `
  -o /work/generated/prefecture-admin-level4.geojson --overwrite

python .\scripts\build_prefecture_overlay.py
```

The compiler simplifies both prefectures as one coverage in projected metres,
so their shared seam remains identical and their polygon interiors never overlap.
