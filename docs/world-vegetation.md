# Worldwide vegetation overview

NEC and Japan enable `map.worldVegetation: "modis-igbp-2023-v1"`. Below zoom 10,
a bundled GeoJSON fill uses the native large-park theme color and 0.8 opacity.
At zoom 10 it disappears and detailed native parks take over. The layer is above
the overview ocean/land and below native map content; theme/style replacement
restores it. No gameplay requests go to NASA, and no existing PMTiles, demand,
boundaries, or routes are changed.

World-layer restoration waits for the parsed style, not for all native source
requests to complete. MapLibre's `isStyleLoaded()` includes source readiness;
using it here delayed initial display and could indefinitely block recovery
after a tile/style switch. The isolated compatibility check uses the same
`Style._loaded` flag as MapLibre's layer-mutation guard, with a public-method
fallback. The browser regression enables both native park layers and simulates
a permanently pending native source during style replacement. Repeated refreshes
must not resubmit vegetation geometry. Pure mock-layer tests missed the original
invalid park filter, so real MapLibre validation is required for filter changes.

NASA GIBS serves the 2023 MODIS MCD12Q1 v061 IGBP classification. Exact published
palette values select classes 1–11: forest, shrubland, savanna, grassland and
wetland. Cropland, urban areas, cropland mosaics, snow, barren land and water
are excluded. This is thematic vegetation, not a park inventory.

The overview samples roughly 2.4 km pixels, removes patches below eight pixels
and holes below four pixels, and simplifies by 0.04 degrees. It is intentionally
approximate, especially at coasts and near zoom 10, and must never classify
demand or computational land boundaries. Processing uses bounded, aligned
256-pixel chunks; non-antialiased fills avoid seams at chunk edges.

## Reproduction

Install the `vegetation` Python extra from `map-creator/pyproject.toml`, then run
from the repository root:

```powershell
python map-creator/scripts/build_world_vegetation.py
```

Progress is printed per downloaded quadrant and processed row. The source lock
is `map-creator/sources/world-vegetation.json`; raw inputs and the final gzip
are SHA256-checked. Cached inputs live in `map-creator/data/sources/world-vegetation`.
The resulting artifact and report live in `map-creator/data/artifacts/world-vegetation`.
Builds require the pinned artifact: 14,393 polygons, 9,249,736 JSON bytes,
1,832,872 compressed bytes. They embed it, decode once off-thread, and install
`SOURCES.md` alongside the bundle. Regenerating changed source data requires
reviewing and updating the lock, not silently accepting upstream changes.

See [SOURCES.md](../SOURCES.md) for attribution and
[source research](../research/world-vegetation-source.md) for selection details.
