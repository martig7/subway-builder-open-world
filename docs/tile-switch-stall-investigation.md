# Tile-switch stall investigation — 2026-09-08

Active consumer: `local.japan-open-world`, built from `prototype/japan/mod`.
Branch: `codex/tile-switch-stall`.

## Reproduction

Live Japan regional save, paused, 316 stations, 53 routes, Tokyo initially active.
A scripted call to the actual geographic overlay tile-click handler selected Kanagawa.
The first attempt completed, retaining the network. The 65-second CPU capture included
about 4.14 seconds in garbage collection and multiple full snapshot copies.
The completion trace included roughly 3.3 seconds building the destination projection
and 3.6 seconds restoring native state. This did not reproduce the user's exact failed
click; it did establish a large transition cost.

Returning to Tokyo after mod reload caused a renderer reload and an empty network.
Restored a completed Tokyo save, then repeated the pair after a fresh renderer load.
Tokyo to Kanagawa completed in 32,491 ms (staging 6,442; navigation 8,339;
completion 17,710). The return stalled and the game renderer exited. A surviving CDP
target stopped answering evaluation and debugger-pause requests. No actionable crash
stack or crash dump was obtained. Native MapLibre errors about null `type` also
occurred on successful switches and are insufficient to assign the failure.

## Delivered copy improvement

Snapshot assembly cloned all old save data before overwriting it with replacement
state. It also cloned old topology before overwriting it with the canonical network.
Clone only retained non-network fields and the save header, keeping output isolation.
No additional cache was introduced.

Regression command:
`node --test --test-name-pattern='native snapshot composition' prototype/kc-two-tile/mod/test/network-projection.test.js`
Before: failed, financial history read twice instead of once.
After: passed, history copied once, discarded topology never traversed, resulting
history/topology/header remain isolated from inputs.

Synthetic benchmark: 100,000 financial-history rows, 20,000 tracks, four iterations.
Before mean 317.01 ms; after mean 148.05 ms (53.3% reduction, 2.14x throughput).
This measures snapshot composition, not whole tile-switch duration.
The second live CPU capture recorded about 3.29 seconds GC, but single captures with
different native loading work are not enough to claim an end-to-end speedup.

Validation: 686 platform tests and 6 Japan tests passed.
Built and installed bundle SHA256:
`32E5B01A387411B9C8325FD33A7FB4FADE085BA1A7BA74673DCF00224583420F`.
Unique marker: `cloneNonNetworkState`; present in both bundles and the live CPU profile.

## Outstanding

The failed return switch/renderer exit remains unresolved. Completed native saves
retain all 316 stations and 53 routes. Restoration after the last renderer exit awaits
the user closing the remaining game window for debugger relaunch.
Raw CPU profiles, exception capture, benchmark output and baseline camera are in the
Git-ignored `.analysis/tile-stall-*` artifacts.
