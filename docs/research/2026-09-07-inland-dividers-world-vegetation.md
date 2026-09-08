# Inland dividers and vegetation outside the World

The active consumer is `local.japan-open-world`, built and installed from
`prototype/japan/mod`. The NEC consumer was also rebuilt with its own vegetation
variant. It was not installed over the active Japan consumer.

## Rendering behavior

The mod no longer draws Japan's administrative coastal outlines. The native
land/water map and the existing world-context map supply the visible coastline.
The visible prefecture layer contains only 88 shared inland dividers. Shared
edges are extracted once from the producer's valid projected coverage before
reprojection; point contacts, unowned lakes and island coastlines are excluded.
Enclave borders remain included.

Selection uses 47 invisible polygons at a fixed precomputed 500-metre display
tolerance. They are approximate hit areas, not replacement ownership geometry.
The line layer filters out polygon geometry, so it cannot redraw their coasts.
Active and hovered prefectures highlight their shared borders through feature
state. An island prefecture with no land neighbor has no internal divider to
highlight. Precise coastline-following hover shading is not synthesized.

The boundary artifact retains generation inputs, but packaging includes only
the selection level and compact divider LODs. The runtime keeps one decoded
divider level, rather than retaining detailed coastal rings. The finest visible
divider level has 75,856 vertices versus 469,893 for the previous full outlines.
`inland-boundary-lod-v5` replaces earlier retained sources on mod reload.

Vegetation follows the active **World footprint**, not the camera's country.
Japan uses its approved prefecture ownership footprint; NEC uses the union of
its 35 selected Tile View bounds. Original vegetation is retained inside that
footprint and a small outward protective margin. The margin is 0.02 degrees,
roughly two kilometres, and prevents simplification from cutting into the World.
It is simplified before clipping so it does not import administrative coastline
detail into the vegetation layer.

Outside that area, vegetation is simplified at 0.2 degrees; patches below 0.02
square degrees and small holes are omitted. Overlaps are dissolved offline to
avoid double-painting translucent fills. The full-detail in-World geometry is
combined with the clipped coarse context after simplification. Ownership,
demand, routing, and native land/water geometry are unchanged.

World Definitions opt into this through `map.worldVegetationDetail: "world"`.
Variants are pinned to their original vegetation bytes, footprint input bytes,
and generated artifact bytes. A changed footprint requires regeneration.

## Generation

Geography processing ran on `richmpc`, in
`C:/Users/gianc/open-world-runs/inland-vegetation-20260908`.
No fresh map tiles, demand data or external imagery were generated.

The normal `display_lods` producer now also emits each level's shared dividers.
For vegetation, run the module with the pinned global artifact and the relevant
ownership GeoJSON or selected Tile View catalog, for example:

```text
python -m open_world_map_creator.focus_vegetation --source modis-igbp-2023-v1.geojson.gz --focus prefectures.geojson --world-id japan-world --output modis-igbp-2023-v1.japan-world.geojson.gz
```

NEC uses `worlds/nec-corridor/geography/tile-views.json` as its focus input and
`nec-corridor-world` as its World ID. Generated variants live beside the global
artifact in `map-creator/data/artifacts/world-vegetation`; their hashes are
recorded in `map-creator/sources/world-vegetation.json`. These are generated data
artifacts, separate from installable mod manifests.

## Measurements

Fresh Node/V8 processes with explicit GC measured only retained decorative
GeoJSON/catalog objects, excluding MapLibre workers, GPU buffers and the rest
of the game:

| Data | Previous | New |
| --- | ---: | ---: |
| Japan boundaries at zoom 13 | 39.2 MiB | 12.4 MiB |
| World vegetation in Japan consumer | 74.7 MiB | 4.8 MiB |
| Vegetation vertices in Japan consumer | 777,103 | 45,304 |
| Vegetation vertices in NEC consumer | 777,103 | approximately 47,000 |

The Japan bundle is 6,296,112 bytes. Its built and installed copies have matching
timestamps and SHA-256:
`56E74AA040A98656A0F29AC821072FF86C01D4DB653D38A16BC3FA0BE36C81C6`.

With user authorization, the existing six-zoom Osaka sequence ran and restored
the exact original camera and paused state. Comparison to the preceding capture:

| Animation-frame gaps | Previous capture | This capture |
| --- | ---: | ---: |
| Median | 16.6 ms | 10.0 ms |
| p95 | 103.4 ms | 49.9 ms |
| p99 | 219.9 ms | 96.6 ms |
| Maximum | 300.0 ms | 236.7 ms |
| Gaps over 100 ms | 25 | 8 |

These are captures using the same harness, not repeated controlled trials with
identical cache warmth. They demonstrate the observed change, not a universal
FPS multiplier. The strict target of no frame gaps over 50 ms still fails.

## Verification

- Platform/fixture suite: 658 passing tests.
- Japan consumer: 5 passing tests.
- Geometry, quantization, divider and vegetation tests: 15 passing Python tests.
- NEC consumer: 16 of 17 passing. The autosave-finance test expects the retired
  live-snapshot reload guard and fails at `autosave-finance-isolation.test.js:255`.
  The same failure was reproduced from an isolated archive of the untouched
  preceding commit. Production recovery/save behavior was not changed here.
- Both Japan and NEC bundles contain the new renderer markers. Japan was
  installed and reloaded; the live source has 47 polygons, 88 divider lines,
  the polygon-excluding line filter, zero selection fill opacity, and 1,786
  vegetation features tagged `focusWorld: japan-world`.
- A live rendered-feature query inside Osaka returned `JP_PREF_27`, confirming
  invisible selection remains queryable. Screenshot inspection confirmed that
  the coastal outlines were removed and inland dividers remain visible.
- The live save retained 316 stations and 53 routes. PMTiles port 8799 returned
  HTTP 200 and `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
