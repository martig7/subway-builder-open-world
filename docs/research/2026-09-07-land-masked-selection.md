# Native land selection and Wakayama exclaves

Implemented on `codex/land-selection-wakayama` for `local.japan-open-world`,
built and installed from `prototype/japan/mod`.

## Geographic decision

The user confirmed that real exclaves must remain. Kitayama and Shingu's
Shimazu district are documented by the local governments:

- https://www.vill.kitayama.wakayama.jp/about/
- https://www.pref.wakayama.lg.jp/prefg/000200/nagomi/w56/16_17/index.html

Authoritative ownership, demand geometry, and shared inland dividers are
unchanged. The display producer extends selection polygons up to 2.5 km
offshore, simplifies those offshore outlines, and allocates overlapping water
areas in stable owner order. It never takes another owner's existing land.
The packer uses these polygons only for selection; divider LODs stay separate.
Japan's selection has 50,457 vertices, within the existing 60,000-vertex limit.

## Rendering

The ocean is a full-world background polygon underneath native land, so moving
the highlight below that layer would hide it entirely. Instead, a bounded
CanvasSource raster layer masks the active/hovered selection against loaded
`world_land` vector polygons and subtracts the same source's `water` polygons.
Overlapping tile buffers are unioned, and polygon holes use even-odd filling.
This follows the visible native coastline without loading a second national
coastline or computing polygon intersections on each animation frame.

The active prefecture uses 14% opacity and hover uses 28%, including prefectures
with no inland dividers. Selection is displayed below zoom 10. During movement
the raster is hidden; it is rebuilt after movement or native tile changes and
paused after one texture upload. The two canvases are capped at 1024 pixels on
their longest edge, and there is only one current viewport. At the tested
1024 x 551 size, the two RGBA canvases plus one texture use approximately
6.5 MiB, excluding browser overhead. They are released on controller disposal.

Markers: `native-land-selection-v1`, `land-masked-boundary-lod-v6`,
`offshore-selection-v1`.

## Validation

- 663 platform/consumer-fixture tests passed; Japan's five behavioral tests
  passed. Geometry LOD, quantization and enclave/offshore tests: 13 passed.
- Actual renderer canvas fixture: land alpha 36/255, overlapping land stays
  36/255, ocean and lake alpha 0. This checks pixel compositing in Chromium,
  beyond the unit tests of mask operations and lifecycle.
- Live Japan regional save: Hokkaido land hover alpha 71/255 and ocean 0;
  Wakayama mainland and both tested exclave points all resolve to `JP_PREF_30`
  with alpha 71/255. Lake Biwa interior points [136.08,35.36] and [136.12,35.4]
  have alpha 0; nearby land [136.25,35.27] has alpha 71/255. An earlier shore
  sample was partially covered by an antialiased edge, so interior points were
  used for the strict water check. Small real lakes absent from the native
  vector tiles are not separately introduced by the mask.
- Individual measured mask updates were 1.5–7.4 ms, including source queries,
  drawing and scheduling the texture upload. This is not a whole-game FPS
  benchmark. The live CanvasSource reported `_playing: false` between updates.
- Camera was restored after the authorized visual check. The save remained
  `JP_PREF_27`, paused, with 316 stations and 53 routes. Subsequent user camera
  movement was left intact.
- Built and installed bundle SHA-256:
  `386FD6CB71EB0BB1098A1102CCBA14EDA7D89B868E6E2D2F1EF1A98A6F405E79`.
  Both files: 6,240,997 bytes, timestamp 2026-09-08 02:58:28 UTC. The running
  renderer exposed the new markers after mod reload and diagnostic reset.
- PMTiles health returned HTTP 200 with `native-pmtiles-directory-v4`.

Ignored local evidence: `.analysis/selection-visual-check.json`,
`.analysis/selection-{hokkaido,wakayama,biwa}.png`,
`.analysis/land-selection-platform-tests.log`.
