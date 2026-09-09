# Native-style cross-city demand panel

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
| Fade demand | Opacity 0.88 → 0.2; zero source updates and zero route requests |
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
