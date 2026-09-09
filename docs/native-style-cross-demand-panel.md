# Native-style cross-city demand panel

## Native demand sizing and construction tools

The population field now uses the native layer's live radius scale and the
game's demand-bubble setting. A bounded sample of unselected native features
calibrates the population-to-radius multiplier against the current tile. Native
selection views are excluded from calibration because their destination dots
use a different curve. Residents, workers, logarithmic scaling and the selected
location's fixed radius follow their corresponding native sizing rules.

MapLibre radii convert metres using deck's current projection: each location's
latitude at lower zooms, and the viewport latitude in its high-zoom projection.
The outline is centered on the native radius, including when a tiny dot's
outline covers its whole fill. Native scale and camera updates repaint the
field without rebuilding its GeoJSON. This replaces the former fixed Kansas
City latitude and independent scaling.

Cross-demand map clicks and hover cursors read the committed native UI context's
`userActionObj.ignoreClick`, the same flag used by native demand. The public mod
API does not expose this flag; the adapter recognizes the mounted provider by
its fields, without importing a hashed game module or retaining an old React
provider across tile switches. Disposal removes the render listener along with
the click and hover handlers.

Validation for `native-demand-dot-parity-v1`: 738 platform/regression tests and
6 Japan consumer tests passed. The new failing checks first reproduced the
scale, projection/outline and construction-click discrepancies. Live checks
then evaluated the installed MapLibre expressions against actual native
features at zooms 10, 13 and 18, with native bubble scales 1 and 5. Diameters
matched to floating-point precision in Osaka and Kyoto. Both native and cross
clicks were suppressed with the parallel-track tool selected; cross selection
worked again with the tool cleared.

The active consumer was `prototype/japan/mod`, manifest `local.japan-open-world`.
The release installation uses `%APPDATA%/metro-maker4/mods/local.japan-open-world`,
so its verified `index.js` was updated directly after the consumer build, with
the prior bundle backed up locally. Built and installed timestamps and SHA-256
matched; the reloaded panel reported the new marker. PMTiles returned HTTP 200
with `native-pmtiles-directory-v4`. The Osaka–Kyoto–Osaka round trip preserved
the native session, clock, pause state and network counts; camera and bubble
scale were restored.

## Panel behavior

The cross-city demand panel follows the native demand workflow: Residents or
Workers, a selected demand location, then a selected commuter group. It uses
the game's font and theme classes, native mode colors and icons, counts alongside
percentages, and compact commuter rows showing departure time and destination.
Internal IDs, routing sources and generalized-cost diagnostics sit behind
Calculation details.

Map travel-mode filtering and fading are available in the overview and location
views. Lists start with five rows, expand to forty, then paginate; large locations
do not create an unbounded DOM list. A four-pixel hit tolerance makes small dots
easier to select without enlarging the rendered field. Escape inside the panel
backs out of the current selection, and navigation resets the panel's scroll.

Home point and Work point move the camera without switching tiles. Show whole
route fits the actual stored geometry with padding calculated from the panel's
position. Selected road routes and their two endpoints remain visible at world
zoom and beyond the active tile's render halo. The general demand field and
per-location connection field retain their detail-zoom gate.

Home departure and work departure histograms use the generated schedule fields.
They are deliberately labeled as departures: they do not claim to be simulated
arrival times. Income-by-income mode charts and large Shift-drag selections were
left out at the user's request because of their potential calculation/rendering
cost. Transit path descriptions remain available; no bulk route fetching or new
per-person simulation was added.

## Performance and lifecycle

- Global totals and 24-bin departure histograms are aggregated during the model's
  existing pop pass, reusing the mode counts already calculated there.
- A global summary and at most four location summaries are retained per model.
  Japan's global summary serialized to 1,955 bytes; this is a payload measurement,
  not a measurement of total JavaScript heap overhead.
- A local run with 33,553 pops and 31,420 locations took 79.4 ms to construct the
  model, 0.13 ms to retrieve its summary and 0.09 ms for 1,000 subsequent summary
  reads. The summary no longer performs a second full-data scan on opening.
- Fading updates paint only. Map-mode filtering rebuilds the dot source once per
  user selection. Pop selection clears the unused global dot source; completing
  its asynchronous road lookup updates only the selected-trip source.
- A selected pop's calculation details are retained once, reused across React
  renders and replaced on mode-share refresh. The comparison's transit result
  is reused rather than inspecting the same transit trip separately.
- Changing Residents/Workers invalidates stale route responses. Closing during
  a style load hides and clears the overlay at idle; disposal detaches listeners.

## Validation

725 platform/regression tests and 6 Japan consumer tests passed. New checks cover
summary conservation and cache bounds, assigned-mode filters, small-dot picking,
bounded source updates, stale asynchronous results, close-during-load cleanup,
trip-detail reuse, endpoint framing and the selected-route zoom exemption.

The active consumer was `prototype/japan/mod`, manifest `local.japan-open-world`.
Its rebuilt and installed bundles matched, including the marker
`native-style-cross-demand-v1`. The shared PMTiles service returned HTTP 200 with
`native-pmtiles-directory-v4` and the stored-route capability.

Live UI checks:

| Action | Result |
| --- | --- |
| Fade demand (initial build; corrected below) | Opacity 0.88 → 0.2; zero source updates and zero route requests |
| Filter Transit | 21,111 → 1,660 dots; one point-source update, zero detail-source updates, zero route requests |
| Select location and pop | Native-style counts, five commuter rows, readable tile names and trip details |
| Work point and Show whole route | Camera moved without a tile switch |
| Aichi → Kanagawa, 320.0 km | 3,581 stored vertices; complete line and both endpoints visible at zoom 8.95 |

The long route was selected through the Workers view and its commuter row. Its
lookup took 86.6 ms in the final live run; the cache contained one 34,910-byte
accounted record and reported zero errors. The panel-aware fit placed both
endpoints outside the panel, without the earlier temporary zoom override.
City, native session, pause state, network counts, money, clock and renderer
time origin matched before and after verification. The game was left paused
with the long route displayed.

Final installed bundle SHA-256:
`FAE7564E3ADD780FA93585C820DBB6B42221DC1C5F57B5040FC81567DD98F05A`.

## Route designs and native fade correction

The native `SubwayBuilderAPI.gameState.getRoutes()` exposes each route's bullet,
full name, color, text color, shape and optional border/font settings. The API's
component collection does not expose `RouteIcon`. The cross-demand panel renders
small DOM badges from those fields, preserving leg order. Designs are read only
for visible trip legs; no native route objects, timetable/track arrays or new
design cache are retained. If a design is unavailable, its readable route name
remains visible. This adds no routing requests or commute calculations.

The initial 20% fade was substantially stronger than native. Inspection of the
installed game's `GameMain` bundle found `demand-points` uses layer opacity 0.33,
but deck transforms its shader uniform with `pow(opacity, 1 / 2.2)`. MapLibre
uses paint opacity directly, so our equivalent is 0.6041471066770493. Both fill
and outline now use that opacity when faded and 1 when unfaded. The regression
check failed against the initial build, then passed with this correction; it
also verifies that toggling fade performs no source writes.

727 platform/regression tests and 6 Japan tests passed. Rebuilt and installed
`prototype/japan/mod` / `local.japan-open-world` with the marker
`native-route-designs-and-fade-v2`. Both bundle hashes and timestamps matched;
PMTiles returned HTTP 200 and `native-pmtiles-directory-v4`.

Live verification through the cross-demand panel displayed the Hiratsuka →
Tameike-Sanno transit path with T01, K11, K07 and K08 badges, each matching its
native route's color and symbol. The selected pop had 167 transit commuters out
of 200. Its stored driving route also loaded successfully (1,123 vertices).
The live fill and stroke opacity both measured 0.6041471066770493. The camera,
paused state and all recorded game/session/network/finance/clock values were
restored or unchanged, and the Residents overview was restored with All modes
and fading enabled.

Installed bundle SHA-256:
`001B597010EBEC2141914117E78EF0711B9D586BDAA53EF950A9ACED3E461678`.

## Simplified controls

Removed the map travel-mode dropdown and both departure-time histograms at the
user's request. The overview and location panel show all travel modes together;
the existing mode counts, Residents/Workers controls, fade toggle and individual
trip details remain. Summary construction no longer allocates the 48 histogram
bins or parses each pop's departure times for chart aggregation.

727 platform/regression tests and 6 Japan consumer tests passed. The rebuilt and
installed `local.japan-open-world` bundles matched by hash and timestamp, and the
PMTiles health check passed. Live UI inspection after reloading confirmed
`simplified-cross-demand-panel-v3`, no mode dropdown and no departure charts.

Installed bundle SHA-256:
`44EE986194CE840C866D4F07910117CAAF306FE84D6BC09FD596621E75A90241`.
