# Bounded transit search

`createBoundedTransitSearch()` is an optional exact accelerator for the existing router. It creates neither a WebAssembly instance nor graph buffers until its first search. `search(router, query)` returns the packed search result, or `null` to request the caller's JavaScript fallback. `clear()` and `dispose()` are equivalent and permit later reuse.

The checked-in kernel preserves cost-first queue order. Destination-cell bounds prune only labels whose optimistic cost exceeds the incumbent; the rejected A* ordering and approximate route-menu reuse are absent. Every ride still evaluates the current router snapshot's service and schedule.

Default resource limits:

- 32 MiB of WebAssembly linear memory, including packed graph and search scratch.
- 4,096 stations, 32,768 edges and 32,768 routing states. Graph and packed schedule/corridor sizes are checked before proportional buffers are allocated.
- Desired scratch capacity of `max(65536, stateCount * 64)` labels, reduced to fit the linear-memory limit. Exhaustion requests JavaScript fallback.
- 8 MiB of partition distance tables and cached bound vectors, at most 128 cached vectors, and at most 2,048 stations for preprocessing. Excessive preprocessing work or table size disables pruning while preserving plain Wasm search.

These limits cover this accelerator, not the total game process or JavaScript fallback. Partition construction and graph packing also use temporary JavaScript collections within the graph dimension caps. `clear()` drops retained graph, partition, instance and buffer references; actual garbage collection and OS memory reclamation remain runtime decisions. Diagnostics distinguish current retained storage from historical peaks.

`kernel-bytes.js` embeds the same 3,449-byte kernel used by the saved-network experiment, with SHA-256 `254c44bf178834301556f40c850a9c9128f1157a7ba1368b372d30a375ea15db`. Its import-free decoding works in Node and browser workers without a fetch or special bundler loader. No runtime imports point into the experiments directory.

To rebuild, set `WASM_CLANG` to the WASI SDK clang executable and run `node build.mjs` from this directory. To regenerate only the embedded module from the checked-in binary, run `node build.mjs --embed-only`. The binary's linker maximum is intentionally unchanged from the measured artifact; the wrapper applies the smaller configured allocation limit before every growth request.
