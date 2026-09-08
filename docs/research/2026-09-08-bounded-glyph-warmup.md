# Bounded native glyph warmup

Implemented for `local.japan-open-world` on 2026-09-08, with the implementation
shared under `open-world-platform/src/runtime/ui/glyph-warmup.js`.

## Behavior and memory bounds

The map warms fonts already used for locally generated glyphs, then fills the
existing MapLibre cache with a small candidate set: catalog label characters and
89 common CJK label characters. Every candidate must pass the installed native
manager's own local-glyph predicate. Latin-only maps do not eagerly load CJK
fonts. The existing font choice, glyph metrics, rasterizer and glyph cache remain
in use; there is no second bitmap or text-measurement cache.

Warmup waits for `document.fonts.load` and runs in idle callbacks while the camera
is stationary. Each callback starts at most four new glyphs and stops starting
work after approximately 2 ms. One indivisible native glyph call can exceed that
target; this is not a hard preemptive frame-time guarantee.

Limits per native glyph manager:

- At most 128 speculative glyphs and two font stacks.
- At most 2 MiB of added bitmap backing buffers and rasterizer scratch arrays.
- Budget survives mod hot reload. New native styles have their own budget.
- No native glyph eviction. Oversized speculative glyphs are discarded before
  publication, including a newly created rasterizer. Failed generation also
  releases its speculative rasterizer.
- Bitmap/scratch accounting excludes JavaScript object overhead, browser font
  internals, and later native worker/GPU atlas copies.

Disposal cancels scheduled work and removes listeners. A pending font load cannot
publish into an obsolete style. Missing/incompatible private native methods
disable warmup instead of replacing native rendering.

## Direct native glyph benchmark

The test runs the game's actual GlyphManager/TinySDF in separate, fresh glyph
managers, without deleting the live map's cache. Each request needs the same 89
characters. Browser/system font caches were already warm, so this measures a
fresh glyph cache, not a first-ever OS font load.

| Repetition | Fresh cache batch | Warmed cache batch |
| --- | ---: | ---: |
| 1 | 55.3 ms | 0.4 ms |
| 2 | 18.4 ms | 0.4 ms |
| 3 | 18.3 ms | 0.4 ms |

Each warmed manager retained 388494 bytes (0.37 MiB) of added buffers for 89
glyphs. Warmup slices peaked at 1.1–1.2 ms, and individual glyph generation at
0.4 ms. This moves generation work earlier; it does not make the same native
`measureText` implementation intrinsically faster.

Evidence: `.analysis/glyph-benchmark.mjs` and
`.analysis/glyph-benchmark-results.json` (local, Git-ignored).

## Installed live behavior

On the Japan save, the first attachment warmed **40 missing glyphs**, adding
**137541 bytes (134 KiB)**. The longest measured warmup slice was **1.3 ms**, the
longest glyph call **0.4 ms**, with **zero errors**. Reloading the final build
reused the same cache and retained budget; the count and byte total did not grow.

The live diagnostic is
`SubwayBuilderAPI.utils.getMap().__openWorldGlyphWarmup.diagnostic`, with marker
`bounded-local-glyph-warmup-v1`. Final runtime generation: 7.

This addresses first-use work for the warmed candidate set. It does not guarantee
that the previously observed 212 ms `measureText` spike is impossible for an
unseen character or a cold browser font fallback. Native geometry rebuilding and
financial dashboard work are independent sources of frame gaps.

## Validation and deployment

- 678 platform/fixture tests and 5 Japan behavioral tests passed (683 total).
- Tests cover native cache hits, idle slice/glyph limits, movement deferral,
  cancellation, buffer rejection, style replacement during font loading, retained
  budgets across old-generation replacement, unsupported/Latin-only maps, and
  speculative-buffer cleanup on rasterizer errors.
- Built from `prototype/japan/mod`; installed manifest `local.japan-open-world`
  under `%APPDATA%/metro-maker4/mods/japan-open-world`.
- Final built/installed bundle SHA-256:
  `13C50B3275F9F561DF73E0AD20D93CFC77C982E892EDB73E3C887F00896263F1`.
- Both copies: 6250072 bytes, timestamp 2026-09-08 13:52:30 UTC, with the unique
  warmup marker present.
- PMTiles port 8799: HTTP 200,
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
- Cached Ultra was restored ready after initialization. Its 28709 assigned pops,
  daily ridership 286819 and daily revenue 261722337.5 remained unchanged.

The established fast pan/zoom harness also records ordinary movement before and
after in `.analysis/glyph-warmup-before.json` and
`.analysis/glyph-warmup-after.json`. Those passes use the already visited Osaka
area and therefore are not an isolated cold-font benchmark. Camera and pause
state are restored by the harness.

| Simulation | Movement | Before p95 / max, ms | After p95 / max, ms |
| --- | --- | ---: | ---: |
| Paused | Pan | 8.7 / 21.6 | 9.7 / 22.3 |
| Paused | Zoom | 33.8 / 157.5 | 76.0 / 222.5 |
| Paused | Pan + zoom | 41.8 / 196.1 | 61.8 / 147.2 |
| Running | Pan | 28.8 / 225.2 | 32.0 / 199.2 |
| Running | Zoom | 77.3 / 198.7 | 139.4 / 259.0 |
| Running | Pan + zoom | 124.2 / 168.4 | 120.8 / 171.6 |

These live passes do **not** demonstrate an overall zoom improvement; several
rows worsened after reload. They include different simulation times and different
tile/geometry cache state. The direct native glyph benchmark above isolates the
benefit we can substantiate. No renderer exceptions or visibility changes were
reported in either movement pass. No measured gap reached 500 ms.
