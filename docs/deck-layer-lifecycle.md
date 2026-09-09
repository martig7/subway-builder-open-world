# Removed Deck layer cache lifecycle

An intermittent `portolan-cats` / `portolan-cat-text` initialization assertion was reproduced by submitting a layer, removing it, and reintroducing the same ID and data through the geographic overlay. Deck initializes a returning ID as new and asserts that the layer has no internalState. The overlay retained the previous initialized layer instance by ID and could return it after removal.

The native setProps wrapper now discards cached layer instances whose IDs are absent from the incoming native tree. Spatial geometry caches remain unchanged. The guard generation advances from 23 to 24 so a mod reload replaces the old wrapper. Tests cover both Portolan layer IDs and replacement of the prior guard generation.

Validation: 734 shared platform tests and all 6 Japan consumer tests passed. The active consumer was `local.japan-open-world` in Kanagawa, built from `prototype/japan/mod`. Its rebuilt and installed index.js hashes and timestamps match, and both contain `pruneRemovedDeckLayerInstances`. World metadata was compared before copying the runtime bundle; city packages and saves were not modified. The tile service remained healthy (`native-pmtiles-directory-v4`).

To avoid interrupting the user's game, the exact pruning helper was applied through a temporary outer wrapper to the active generation-23 guard. Its `deck-layer-lifecycle-v1` diagnostic initially removed 13 absent cached layer instances. The installed generation-24 bundle takes over on the next ordinary reload. This is a targeted live patch, not a claim that the whole rebuilt bundle was reloaded. No controlled camera or tile-switch test was performed, and public release assets were not changed in this fix.
