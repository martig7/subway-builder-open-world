# C++ / WebAssembly commute-search experiment

This experiment plugs a compiled search kernel into the platform's existing
JavaScript worker boundary. The production default remains the optimized
JavaScript search. It adds no server or remote execution dependency.

`transit-search.cpp` contains the schedule-aware search and matching priority
queue ordering. `transit-search.js` packs each graph once per graph replacement,
reuses bounded scratch memory across queries, and returns the chosen edge chain.
The platform still owns catchments, exact-path caches, journey materialization,
mode choice, native fare callbacks, assignments, and finance publication.

The module has no imports, WASI calls, shared memory, threads, or JavaScript
callbacks during graph traversal. An exhausted label buffer returns control to
the JavaScript search. The experimental implementation retains the platform's
exact-path cache but does not retain resumable origin-search trees. Thus this
comparison measures two concrete implementations, including different memory
representations and origin-cache policies, rather than compiler speed alone.

## Build and test

Set `WASM_CLANG` to a Clang executable with the wasm32 target and `wasm-ld`
alongside it, then run from the repository root:

```powershell
node open-world-platform/experiments/commute-wasm/build.mjs
node --test open-world-platform/experiments/commute-wasm/transit-search.test.js
```

The checked-in module was built locally with the official WASI SDK 34 Windows
x64 compiler (Clang 23.1.0-rc3), using `-O3`, disabled floating-point contraction,
and no standard library. `build.mjs` prints its exact flags and output SHA-256.
The SDK download SHA-256 was
`cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f`.
The 3,067-byte module SHA-256 is
`09934501602cd20490271c837a24d89ee8baec43cd47a2f958f7f5c4267157e6`.
Compiler downloads remain in the ignored local investigation directory.

Instantiate `createWasmTransitSearch(bytes)` and pass the result as `searchKernel`
to `createCrossTileRoutingCache`. Use one instance per worker/cache; the instance
owns its packed graph and scratch memory. Browser builds can use esbuild's binary
loader for the `.wasm` asset. Initialization occurs in the worker.

Tests compare full journeys across seeded branching networks, schedules crossing
midnight, explicit departure phases, driving access, transfers, cache reuse,
World changes, service edits, and forced scratch exhaustion. The live benchmark
also compares complete output hashes for the captured player network. These
checks establish parity for the tested cases, not every possible host input.

## Reproduce against the open game

The live harness currently targets the Japan consumer (`local.japan-open-world`)
and the `Subway Builder` page at the local debugging endpoint on port 9222.
Pause the simulation first. It replaces evaluator methods temporarily, toggles
cached simulation, invalidates the served tiles' derived finance profiles, and
invokes the real runtime recalculation. It restores the evaluator methods and
initial enabled state afterward. It does not advance the clock or edit topology.
Do not run overlapping benchmarks, builds, or CPU-heavy tools while measuring.

Run these commands from the repository root with the game and debugging open:

```powershell
node open-world-platform/experiments/commute-wasm/build-workers.mjs
node open-world-platform/experiments/commute-wasm/bind-live-runtime.mjs
node open-world-platform/experiments/commute-wasm/run-in-game.mjs .analysis/commute-perf-inject-factories.js .analysis/commute-benchmark-setup.json
node open-world-platform/experiments/commute-wasm/run-in-game.mjs open-world-platform/experiments/commute-wasm/benchmark-live.js .analysis/commute-benchmark-live.json
```

In the game JavaScript console, set `__commuteBenchmarkLiveVariants` to an array
containing `original`, `javascript`, and/or `wasm` to choose the order, and set
`__commuteBenchmarkLiveRepeats` to choose repetitions. The default is one pass
of optimized JavaScript followed by WASM. Each pass uses fresh evaluator workers.
`original` freezes the router at commit `3384f8fce72fb6285310f020f323c2f71b7c6812`.
Do not reload mods during a run. After reloading, bind the runtime again.

The runner temporarily suppresses debugger pauses on the page and demand workers;
keep breakpoints disabled for clean timing. An optional final `profile` argument
writes CPU profiles, but profiled times must be reported separately.
`__commuteBenchmarkLiveProgress` and `__commuteBenchmarkLiveResults` expose
progress and completed rows without starting another calculation.

For captured-worker comparison, load a private capture with
`node open-world-platform/experiments/commute-wasm/load-captured-inputs.mjs <capture.json>`
and run `benchmark-captured.js` through the same runner. Capture rows contain the
original worker input, optional gzip bytes in `message.bytesBase64`, recorded
native fare responses in `quotes`, and the original full-output SHA-256 in
`hash`. Captures and player save data remain local and are not committed.

Full-output comparisons omit only cache keys and routing counters. A differing
journey, fare, assignment, mode choice, or revenue is a hard failure. Live hashes
also check published demand assignments, finance profiles, and cross-tile choices.

See [the September 12 performance report](../../../docs/commute-worker-performance.md)
for measured results and their boundaries.
