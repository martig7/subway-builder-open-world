# Japan world background

The active consumer is `prototype/japan/mod`, manifest
`local.japan-open-world`.

The September 5, 2026 installed-data audit found `world_land` in the z0 tiles
of Tokyo and Kanagawa only. The other 45 Japan archives contain local city
layers. The geographic overlay previously cloned the active city's tile URL
for its world source, leaving ocean and prefecture outlines when a local-only
archive was selected.

Japan now declares `map.worldContextTileId: JP_TOKYO_MAINLAND`. The shared
runtime resolves that registered archive through the configured tile server
and uses it independently of the active city's detailed tiles. This archive
already contains worldwide land and country boundaries through z9; those
tiles overzoom for context at higher zooms. No map or routing regeneration is
needed. The selected-package validation prevents publishing a definition whose
background archive would not be installed.

Ocean, low-zoom land, and high-zoom land are ordered below all native content
layers, including native land fills and interleaved Deck layers. The opaque
native background remains the bottommost base. Refresh repairs retained layer
order and replaces world sources that still reference a previous city or zoom
range. `independent-world-context-v1` identifies this implementation.

Verification includes a regression covering retained source/order replacement
and switching from Osaka to Hyogo, a Japan consumer test for the registered
world source and configurable server URL, and 60 successful live `world_land`
checks at z0–9 across Osaka, Tokyo, Sapporo, Naha, New York, and Paris. The game's
rendered result must still be checked after the user reloads the installed mod.

The fix was rebuilt and installed as version `0.5.0`. All 495 platform tests
and 4 Japan tests passed. Built and installed bundles match by SHA-256 and
timestamp (`2026-09-05T15:06:36.6245925Z`), including the new context marker and
the retained boundary LOD/label markers. The restarted official v4 tile server
is healthy with all 81 Japan/NEC archives, and the installed definition's
background URL returns `world_land` at Japan overview zoom.
