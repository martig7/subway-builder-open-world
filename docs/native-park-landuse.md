# Native park compatibility

Worlds opt into the shared renderer adapter with
`map.nativeParkSourceLayer: "landuse"`. The default remains `parks` so Worlds
with native-schema Tile Packages are not changed. NEC and Japan opt in.

The adapter redirects the existing native `parks-large` and `parks-small`
layers to `general-tiles/landuse`, accepting only `kind=park`. It preserves
native paints, layer ordering, foundation-mode visibility, and zoom fades.
There are no global modding API overrides, new park layers, or archive rewrites.
The mapping is restored after native theme/style replacement and released when
the World controller detaches. Native park colors remain native-owned.

Subway Builder 1.7 filters parks by `area` in square metres: large is at least
100,000 m²; small is below that. Large parks have no native zoom fade; small
parks fade between zoom 12 and 12.5. Both reach 0.8 opacity. The Open World
native-detail gate also hides these layers below zoom 10.

Current Depot land-use features do not provide `area`. The adapter deliberately
renders all `kind=park` features through `parks-large`, without inventing stored
areas. `parks-small` is filtered empty to prevent duplicate painting. This
removes the small-park fade; airports remain excluded. Retained v1/v2 adapters are
restored before attaching v3. The always-false small-park filter uses an explicit
`literal` expression: a bare numeric comparison is interpreted as a legacy
property filter by MapLibre and rejected. Below zoom 10, the separate
[world vegetation overview](world-vegetation.md) supplies coarse greenery.

## Full installed-archive audit, 2026-09-05

Every encoded tile was read, including Tokyo/Kanagawa's separately named
packages. Counts below are **tile-feature occurrences**, not unique places:
zoom levels, tile cuts and overlapping packages repeat features.

| World | Archives | Encoded tiles read | `landuse:park` | `landuse:aerodrome` |
| --- | ---: | ---: | ---: | ---: |
| NEC | 34 | 5,577,074 | 273,350 | 14,070 |
| Japan | 47 | 2,123,202 | 882,671 | 14,220 |

These were the only `kind` values found in `landuse`; no `parks` source-layer
features were found. Airport/aerodrome polygons remain excluded from parks.

Both Worlds declare the same source layers: `buildings`, `city_labels`,
`commercial`, `hospital`, `industrial`, `landuse`, `neighborhood_labels`,
`residential`, `suburb_labels`, and `water`. Separate world-context geography
is outside this park classification.

Reproduce the read-only audit using the `landuse-audit` Python extras:

```powershell
python map-creator/scripts/audit_landuse.py --root "$env:APPDATA/metro-maker4/cities/data" --prefix NEC_ --prefix JP_ --output .analysis/landuse/inventory.json
```

The audit prints per-archive progress and never changes packages, demand,
routing, saves, or settings. Raw local results are retained under
`.analysis/landuse/` (ignored by Git).
