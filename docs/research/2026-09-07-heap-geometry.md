# Japan heap analysis and display geometry budget

The active consumer is `local.japan-open-world`, built from `prototype/japan/mod`.
The test save is the Japan regional Osaka save (`JP_PREF_27`), with 316 stations,
53 routes, 217 native trains, simulation paused and cached simulation disabled.

## Evidence and limits

The initial renderer reported 1,785,013,928 bytes of used JavaScript heap and
704,132,755 bytes of backing storage. A full CDP heap snapshot disconnected the
renderer before emitting any snapshot chunks; the user confirmed a crash. No
dominator-tree attribution is claimed from that failed capture.

After relaunch, CDP allocation sampling at a 65,536-byte interval covered save
loading and the following 35 seconds. It sampled surviving allocations, not all
objects that existed before sampling began. The largest individual sampled
allocation stacks included:

| Allocation stack | Sampled bytes |
| --- | ---: |
| Native `loadData` | 149,965,692 |
| Native `unpackTileCollections` | 62,459,224 |
| Mod worker message delivery | 49,581,612 |
| Native road-index entry construction | 48,913,420 |
| Native `unpackToLineFeatures` | 26,846,332 |
| Mod projection snapshot cloning | 25,834,488 |

These are sampled self-allocation estimates, not exact retained sizes of named
caches. Boundary literals had already loaded before this sampling window.

A separate, yielding census of reachable plain objects found over 1,016,664
arrays in the native roads source (the scan hit its 1.5-million-object safety
limit), 841,961 arrays in world vegetation, and 56,655 arrays in the currently
submitted boundary source. Shared references were counted once, in traversal
order. The census does not include every closure or worker heap. In particular,
it does not count all unused boundary levels through the current map source.
Our track geometry snapshot contained 45,401 additional arrays; it was much
smaller than those native and decorative data collections.

Vegetation is already a coarse global raster-derived display, simplified at
0.04 degrees. Further arbitrary simplification would noticeably degrade it.
Road data and demand cannot safely be treated as purely decorative. This change
therefore targets the unnecessarily detailed, eagerly retained boundary LODs.

## Changes

The original boundary artifact contained 1,690,099 coordinate pairs across its
base features and five LODs. The base repeated the coarsest level; the finest
level alone contained 932,578 pairs.

The map producer now applies topology-aware precision reduction to explicit
display-only geometry on a 0.00001-degree grid (roughly one metre). Naive decimal
rounding was rejected after it created self-intersections and collapsed rings.
All quantized prefecture geometries are valid; the largest per-prefecture area
change is below 0.001%. Exact geographic-coordinate coverage validation was
already false for the original projected-back LODs, so this work does not claim
to have repaired every pre-existing inter-prefecture coverage defect. Synthetic
shared-border coverage tests pass.

Packaging reuses the existing shared-border simplification and caps decorative
detail at 25 metres, omitting the unsimplified level. Sub-resolution detached
islands follow the existing 25-metre LOD's island policy. All 47 prefectures,
stable feature IDs, holes, hover targets and tile selection remain supported.
Authoritative ownership and computation geometry are untouched.

Unused levels are stored as compact integer-delta strings. The catalog decodes
only the requested geometry and retains at most one decoded level per owner.
The renderer continues to defer refinement until zoom ends. Its boundary
generation advances to `quantized-boundary-lod-v4`, so reloading a mod replaces
previous geometry even when the selected zoom level is unchanged.

## Reproducible boundary heap measurement

Fresh Node/V8 processes, explicit GC, same catalog and boundary rendering seam:

| Case | Retained heap bytes | Approx. MiB |
| --- | ---: | ---: |
| Original overlay, zoom 8.5 | 123,193,624 | 117.5 |
| Packed overlay, zoom 8.5 | 9,938,848 | 9.5 |
| Packed overlay, zoom 13 | 41,131,384 | 39.2 |

This is a 91.9% reduction at zoom 8.5 and a 66.6% reduction at maximum detail;
the original eagerly retained all levels at either zoom. The packed payload is
5,448,784 bytes, versus roughly 66 MB of original boundary JSON. These figures
exclude MapLibre worker and GPU allocations. Cold decoding took 4.5 ms at zoom
8.5 and 47.8 ms at maximum detail on this machine: laziness trades a one-time
refinement cost for lower retained memory. Repeated access reuses that level.

`open-world-platform/scripts/benchmark-boundary-heap.mjs` provides the benchmark.
Run each measurement in a fresh process with `node --expose-gc`, passing the
world directory, overlay JSON and zoom. Use `pack` as the last argument to emit
the packed artifact first. Use the preceding commit's display artifact for the
original baseline, rather than comparing the new quantized artifact to itself.

## Delivery verification

Platform and fixture suite: 653 passing tests. Japan consumer: 5 passing tests.
Geometry and quantization: 10 passing Python tests. Polygon validation passed
for every prefecture at all rendered LODs. The Python geometry checks required
the project's declared `jsonschema` dependency in an ignored local test directory.

Built and installed bundle SHA-256:
`E8616E8E5760D13B80EACF93E9041CDD6995020EEC3ABAC0309068AB9803F606`.
Both copies carry `quantized-display-boundaries-v1` and
`quantized-boundary-lod-v4`; timestamps match. PMTiles port 8799 returned HTTP
200 with `X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

An ordinary page reload initially continued to execute the old mod. Explicit
mod reload followed by the native saved-file renderer reload produced runtime
generation 1 with the new boundary marker and completed demand recalculation.
The save's station and route counts remained intact. A whole-renderer heap
comparison during this sequence was confounded by camera movement and tile
residency; the isolated boundary measurement above is the controlled memory
result, not a claim that all renderer memory fell by 92%.

## Live zoom follow-up

After the user confirmed readiness, the existing six-zoom Osaka harness ran and
restored the exact starting camera and paused state. It recorded:

| Animation-frame gap | Previous delivered capture | New capture |
| --- | ---: | ---: |
| Median | 13.3 ms | 16.6 ms |
| p95 | 86.7 ms | 103.4 ms |
| p99 | 423.3 ms | 219.9 ms |
| Maximum | 623.4 ms | 300.0 ms |
| Gaps over 100 ms | 20 | 25 |

The route and harness match, but process age and tile/cache warmth differ.
This is useful follow-up evidence, not a controlled claim of an overall FPS
speedup. The worst tail improved in this capture, while ordinary hitches became
more frequent. The strict target of no gaps above 50 ms still fails.

The 300-ms gap included native path normalization, GPU attribute preparation and
uploads, with about 24 ms of sampled GC time. Another 277-ms gap included cache
snapshot construction, clipping and about 27 ms of GC. Reducing decorative
retention does not eliminate the cost of constructing those native layers and
cache snapshots. Screenshot inspection confirmed the boundary overlay remains
visible after the test.
