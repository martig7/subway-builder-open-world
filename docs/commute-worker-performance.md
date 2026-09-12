# Commute worker performance — September 12, 2026

The C++/WebAssembly experiment was faster on the captured player network while
returning the same results. It runs inside the existing local JavaScript workers;
there is no compute server or use of another machine. The delivered production
change is the shared JavaScript allocation optimization. WASM remains an explicit
experiment, with source, compiled module, tests, and a live benchmark harness in
[`open-world-platform/experiments/commute-wasm`](../open-world-platform/experiments/commute-wasm/README.md).

## What changed before comparison

The shared schedule-aware search now precomputes destination-state keys, rejects
losing candidates before allocating labels, and constructs accepted labels with
explicit fields instead of copying the whole previous label. The graph/cache
generation is `cross-network-graph-cache-v2`. This search is used by active-tile
ultra-fast preparation, off-tile native finance, and cross-tile mode choice.

A regression test failed before the fix and passes afterward. In the captured
ultra-fast workload, the optimized search creates 12.49 million labels across
30.41 million edge relaxations. The off-tile workloads create 25.28 million labels
across 60.17 million relaxations. The original algorithm attempted to construct a
label before deciding whether its cost could improve the destination state.
An exploratory original-worker CPU profile showed substantial search and garbage
collection cost; its profiled elapsed time is not used as a clean benchmark.

## Controlled worker comparison

These are one-pass elapsed measurements through the real worker factories in the
open game's renderer, using identical captured input and native fare responses.
Each backend starts with fresh workers; the native worker is reused across its
input sequence. No profiling, builds, or tests ran concurrently.

| Workload | Optimized JavaScript | C++ / WASM | JS time / WASM time |
| --- | ---: | ---: | ---: |
| Ultra-fast preparation, 34,027 cohorts | 21.510 s | 7.683 s | 2.80× |
| Off-tile native evaluations, 510,650 cohorts in 34 tiles | 44.443 s | 20.294 s | 2.19× |
| Cross-network mode choice, 73,913 cohorts | 7.456 s | 3.655 s | 2.04× |
| Off-tile evaluations + cross-network calculation | **51.900 s** | **23.949 s** | **2.17×** |

Timing includes worker initialization, input dispatch, byte copying/decompression,
calculation, native fare round trips, and returning the result. It excludes loading
the saved input into the renderer, output hashing, and applying the result to the
live runtime. The off-tile figure is the sum of sequential tile evaluations.

All **72 full-output comparisons** passed: 36 distinct workloads through each of
the two backends matched the original implementation's saved output hash. Only
`routingStats`, `contextKey`, and `evaluationKey` are omitted from hashing; journeys,
assignments, mode choices, fares, and revenue remain covered. A new/different fare
request is a hard failure, not an assumed zero fare.

## Complete in-game operations

JavaScript injected through the existing debugging endpoint triggered the real
cached-simulation controller and `WorldTileRuntime.recalculateCrossTileModeShare`.
For recalculation, all 34 served tile profiles had both cache keys invalidated;
13 unserved tiles remained cached. Ultra-fast stayed enabled throughout the
recalculation, retaining its existing suppression of native commute refresh.
These runs include fetching packages and applying the resulting profiles/choices.

| Run order | Backend | Ultra-fast enable | Forced off-tile recalculation |
| --- | --- | ---: | ---: |
| Pair, first | Optimized JavaScript | 20.641 s | 114.529 s |
| Pair, second | C++ / WASM | 8.114 s | 28.993 s |
| Three-way, first | Original JavaScript | 34.524 s | 91.089 s |
| Three-way, second | C++ / WASM | 8.224 s | 28.652 s |
| Three-way, third | Optimized JavaScript | 71.575 s | 56.413 s |

All five runs matched the same hashes for published commute assignments, native
tile finance profiles, and cross-tile choices. They assigned 34,027 cohorts and
produced identical cached daily revenue of 11,193,896,266.75. The simulation clock
and topology did not change during any measurement.

WASM's two live samples are consistent (8.1–8.2 s and 28.7–29.0 s). JavaScript's
wide variation means this small sample does **not** establish a stable end-to-end
speedup from the JavaScript-only optimization. The controlled worker comparison
is the cleaner evidence for WASM's benefit. Do not interpret the two live samples
as a latency guarantee or as directly comparable to an ordinary partially cached
10-second/30-second refresh.

Earlier exploratory runs included a debugger-paused worker; those stalled runs
are excluded. The benchmark runner suppresses debugger pauses for its duration.
A later status inspection during the three-way run found no paused debugger.
The live cached-posting preparation counters also recorded timeouts/fallbacks in
the variable run. The measurements do not isolate the cause of all variation.

## Scope and limitations

The C++ kernel uses packed numeric graph data, reusable bounded scratch memory,
and no JavaScript callbacks inside graph traversal. JavaScript still owns
catchments, exact-path caching, journey materialization, native fares, assignment
publication, and finance. A label-buffer overflow falls back to JavaScript.

The experiment does not retain the JavaScript router's resumable source-search
trees. Both retain exact-path results. This measures two concrete implementations
with different memory layouts and cache policies, not a pure language comparison.
The captured ultra-fast workload had only four resumable source-search hits;
cross-network mode choice had 1,058, so WASM does slightly more search work there.

The module was compiled locally using the official WASI SDK 34 Windows x64 Clang
compiler with `-O3`, no fast math, and floating-point contraction disabled. It is
3,067 bytes and imports no runtime functions. See the experiment README for exact
build commands, checksums, parity coverage, and live reproduction instructions.
The parity checks establish equivalence for these cases, not every possible input.

## Environment and delivery

- Local AMD Ryzen 9 5900X, 12 cores / 24 logical processors, approximately 64 GiB RAM.
- Node 24.13.0; the actual game renderer/workers perform the browser measurements.
- Active manifest: `local.japan-open-world`; consumer: `prototype/japan/mod`.
- Active city: `JP_KANAGAWA_MAINLAND`; 678 stations, 78 routes, 4,382 tracks, 610 trains.
- Fixed benchmark clock: 219,695,757 simulation seconds.
- Original router: commit `3384f8fce72fb6285310f020f323c2f71b7c6812`.
- Final checks: platform 821/821, Japan 7/7, experimental WASM 3/3; script syntax
  checks and benchmark worker generation passed. Platform tests use an ignored
  workspace-local TEMP/TMP directory to avoid an existing cross-drive fixture issue.
- Japan was rebuilt and installed into the matching `local.japan-open-world`
  directory. Built and installed bundles have identical SHA-256
  `C7BD0CD037416D5382636F43BC61F581CBC431509F3E5F2A0F4B128E3C9BC63B`
  and UTC timestamp `2026-09-12T19:11:12.3230070Z`.
- Hot reload reports generation 2, the allocation version marker, and the final
  optional-kernel seam in the active native worker source. Production defaults to
  JavaScript; the experiment is not enabled by installation.
- The final installed-build smoke check enabled ultra-fast in 26.861 s, assigned
  all 34,027 cohorts, and matched the benchmark revenue. The active production
  tile profile recorded 12,493,692 created labels across 30,418,898 relaxations.
  Cached posting preparation completed without fallback. Temporary evaluator
  substitutions were removed and the original running ultra-fast mode restored.
- PMTiles health returned HTTP 200 with `native-pmtiles-directory-v4` and the
  `stored-driving-routes-v1` route archive header.

Compact raw timing/correctness records accompany this report in
[`commute-worker-performance-results.json`](commute-worker-performance-results.json).
Player captures, save paths, compiler downloads, and exploratory profiles remain
in the Git-ignored local investigation directory.
