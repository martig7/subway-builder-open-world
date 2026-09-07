# Station icon attributes and startup navigation

Active consumer: `local.japan-open-world`, built from `prototype/japan/mod`.
Branch: `codex/station-icon-attributes`.

## Findings

The reported `station-marker-labels` error is reproducible when camera changes
leave a native IconLayer with zero instances. Deck still validates the first
four `instanceIconFrames` values, although its updater wrote no instances.
The pooled buffer can contain non-finite values. The original 24-change live
camera loop recorded 14 failed native attribute checks, including failures
immediately after populated labels returned.

The shared Deck guard now omits empty station-label layers before native
attribute processing, including arrays emptied by spatial clipping. It retains
the canonical native input and invalidates the cached rendered layer, since
Deck finalizes removed layers. Returning labels receive a fresh layer instance.
Guard generation 18 replaces generation 17 and its retained wrapper.

The user also reported clicking a prefecture during startup recalculation after
a fallback save load. The grid was exposed after runtime boot but before its
deferred demand calculation finished. Its callback could enqueue a save and
navigation transaction in that window. Navigation now returns `initializing`
with a notification during startup demand, session reload, and pending tile
transitions. Blocked clicks are discarded. Each grid is bound to its originating
session so retained callbacks cannot navigate a replacement session. Completion
of the startup promise clears the gate even if calculation returns a failure;
ordinary later demand refreshes do not permanently lock navigation.

This addresses the reproduced icon error and the observed startup overlap. It
does not establish that every native renderer crash has the same cause. The
save-based native renderer reload guard remains enabled and unchanged.

## Validation

- Shared platform and KC seam suite: 645 passed.
- Japan consumer suite: 4 passed.
- New empty-icon regression failed before the fix and passed afterward. It
  covers native empty arrays, spatially clipped arrays, hidden arrays, and
  reusing the original populated input after removal. The hot-reload regression
  verifies replacement of the old guard object and wrapper.
- New startup-click regression failed before the navigation gate and also
  caught a retained callback navigating a replacement session. It now verifies
  no staging before or during deferred demand, no automatic replay, successful
  later navigation, and rejection of old-session callbacks.
- Live native save: `[Auto] 2026-09-07_19-46-37`, Osaka (`JP_PREF_27`), 316
  stations and 53 routes. The user saved and closed the game before restarting
  with debugging enabled. The rebuilt mod was reloaded before loading the save.
- Live startup probe held the deferred demand callback, invoked the actual grid
  selection callback for another prefecture, and observed `initializing` with
  marker `startup-navigation-v1`. Osaka stayed active and no pending navigation
  was staged. Releasing the callback completed demand in about 12.9 seconds;
  selecting the current prefecture then returned `already-active`, proving the
  gate had unlocked without initiating an unnecessary tile transition.
- Original 24-change camera loop after installation: zero invalid checks,
  17 populated-layer samples and seven omitted-layer samples.
- Repeated with Ultra-high-speed mode enabled and movement diagnostics reset:
  zero invalid checks, 16 populated-layer samples and eight omitted-layer
  samples. Cached simulation reported `ready`; live Deck guard reported 18.
- Final populated icon atlas frames were finite, and a screenshot visually
  confirmed Osaka station labels including Namba and Sumiyoshitaisha.
- Restored the loaded camera and simulation setting; game remains paused.
  Temporary startup interception and movement profiling were removed/disabled.

Live harnesses and captures are in the ignored `.analysis/icon-*` debug files.
These are correctness checks, not a new foreground frame-time benchmark.

## Delivery evidence

Japan `dist/index.js` and installed `mods/japan-open-world/index.js` share:

- SHA-256: `B9D3771386844585828A2D65649F4F6125D97714DAA32F753271E9849E6BDC77`
- Timestamp: `2026-09-07T23:48:54.6026464Z`
- Markers: `omitEmptyStationIcons`, `startup-navigation-v1`.

The configured PMTiles endpoint `http://127.0.0.1:8799/_health` returned HTTP 200
with `X-PMTiles-Server-Version: native-pmtiles-directory-v4` after installation.
