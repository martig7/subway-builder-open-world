# Zoom geometry and boundary uploads

Consumer: `local.japan-open-world`, built from `prototype/japan/mod`.
Branch: `codex/native-tile-zoom`.

## Cause and changes

The live six-zoom CPU profile attributed the largest mod costs to spatial line
clipping when detail became visible, plus serializing boundary GeoJSON whenever
the camera crossed another precomputed detail level. Hidden layers discarded
their spatial cache. On reveal, unchanged data was clipped and uploaded again.

The Deck guard now retains clipped data for static road, runway, and station
platform FeatureCollections while hiding their layers. It checks a detached
content snapshot on reveal, so edits made to the same native array while hidden
still invalidate the cache. Keeping the clipped data on the hidden layer also
preserves its uploaded buffer identity. Dynamic population and train behavior
continues using the existing mutation-aware paths.

Line clipping now accepts or rejects a whole line by its bounds before doing
segment intersection work. Boundary-crossing lines and invalid-vertex breaks
keep the original clipping path. Render coordinates remain detached from the
native network. A deterministic 12,000-road benchmark against 12 halo boxes
fell from 199.4 ms to 59.2 ms (3.37 times faster), with the same 419,520 output
vertices. This is a clipping benchmark, not an overall frame-rate claim.

Boundary refinement waits until `zoomend`. The source retains the most detailed
geometry already submitted, allowing MapLibre to reuse its tiled data across
later zooms rather than repeatedly serializing and replacing the entire source.
Feature state still updates hover and active-prefecture styling during a zoom.
Replacing the source or style causes a fresh submission. MapLibre continues to
simplify/tile the retained geometry for the current view.

The movement guard generation is 21, replacing the retained old closure on mod
reload. Boundary diagnostics use `retained-boundary-lod-v3`.

## Verification

- 649 shared platform/fixture tests and four Japan consumer tests passed.
- New regressions first failed on repeated buffer allocation and mid-gesture
  boundary uploads, then passed after the changes.
- Road, runway, and platform cases verify buffer identity across repeated
  hide/reveal cycles and invalidation after in-place hidden geometry edits.
- The clipping regression reduced coordinate reads from 1,980 to at most 400
  for a 100-vertex whole line; crossing and invalid-coordinate cases still pass.
- Existing guard-replacement and empty-station-icon regressions pass.

Live measurements use the same Osaka save (`JP_PREF_27`), 316 stations and 53
routes, with simulation paused and Ultra mode off. The second-monitor game was
visible with unthrottled animation callbacks. Each profile uses the same six
zooms from 8.5 to 13 across three centers, with a 1 ms CPU sampling interval.
The camera and pause state are restored after every capture. Timings describe
animation-frame gaps, including tile processing and renderer work, not GPU-only
render time. Native caches and garbage collection introduce run-to-run variance.

Baseline: 230 ms at the 95th percentile, 593 ms maximum, 38 gaps over 100 ms.
The first cache/boundary pass reached 103 ms at the 95th percentile. Adding the
whole-line clipping fast path reached 80–83 ms in two captures, but a repeat
exposed additional polygon-copy allocations; those motivated retaining runway
and platform buffers as well. Raw profiles and scripts remain ignored under
`.analysis/zoom-*`.

## Delivered results and limits

The final generation-21 capture (`zoom-delivered`) recorded:

| Animation-frame gap | Baseline | Delivered |
| --- | ---: | ---: |
| Median | 16.6 ms | 13.3 ms |
| 95th percentile | 229.9 ms | 86.7 ms |
| 99th percentile | 413.3 ms | 423.3 ms |
| Maximum | 593.4 ms | 623.4 ms |
| Gaps above 100 ms | 38 | 20 |

The 95th percentile fell 62.3%, and gaps over 100 ms fell 47.4%. This does not
eliminate all zoom stalls: the strict harness target of every gap below 50 ms
still fails. The worst delivered gap contained approximately 442.7 ms of garbage
collection; native worker delivery/rendering and ribbon clipping also remain.
There is no demonstrated improvement in the maximum or 99th-percentile gap.
The final result should be described as a zoom optimization, not hitch-free
rendering. A future memory/allocation profile is needed for the remaining long
GC pauses; repeated profiler runs and mod reloads can also affect GC timing.

The live game reported runtime generation 4, movement guard 21, and boundary
version `retained-boundary-lod-v3`. Startup demand completed before measurement,
and movement diagnostics were reset before the capture and disabled afterward.
The camera returned to longitude 135.57743168868603, latitude 34.754846867833706,
zoom 10.3681120741711, with bearing/pitch zero. The game remains paused, Ultra
off, with 316 stations and 53 routes. The final map screenshot was inspected.

Both Japan `dist/index.js` and installed `mods/japan-open-world/index.js` contain
`retainedStaticGeometry`, `retained-boundary-lod-v3`, and guard generation 21:

- SHA-256: `2D17FFDD1D63EA47B4FCAA36161B1206B0DAF8DAC8C46831767FEFA961D8DB1C`
- Timestamp: `2026-09-08T00:45:35.1020968Z`
- PMTiles health: HTTP 200 at `http://127.0.0.1:8799/_health`, header
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.
