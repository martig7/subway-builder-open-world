# Route-menu reuse experiment: rejected

The route-reuse candidate saves too little additional time to justify its errors on the latest saved Japan network. Keep the exact Wasm + aggregation + mode-choice combination as the selected result; this wrapper remains an isolated experiment and is not imported by production.

`createRouteReuseSearch(baseKernel, options)` groups queries by nearest origin/destination station. The measured configuration reuses candidates across all departure times, retains at most 4,096 menus with two candidates each, caps individual paths at 512 edges, and caps total retained edge references at 200,000. Up to three eligible access stations along a cached path can be tried. Router replacement clears the menus, covering the immutable graph snapshots produced after topology, service, rule, or World changes.

Each candidate is replayed with the current query's access and egress, train phases, timetable periods, boarding gap, dwell, and perceived-time weights. If no candidate is feasible below the query's incumbent bound, the wrapper invokes the normal Wasm search. This preserves the schedule semantics of the existing router. It does **not** establish that a cached feasible route is close to optimal: another route, transfer, access station, or departure pattern can be much better. Optional deterministic audits compare against a fresh search and refresh alternatives, but were disabled in the measured speed variant.

## Saved-network result

The full capture covers Chiba, Tokyo, and Kanagawa, both commute directions, 168,765 cohorts, and two repetitions per variant. These are separate-process CPU replays of saved inputs, not in-game crash or midnight-timing measurements. Timing and error figures below come from `.analysis/commute-speed-full/summary.json`.

| Variant | Combined median time | Maximum process RSS |
| --- | ---: | ---: |
| Wasm baseline | 105.59 s | 402.27 MiB |
| Wasm + exact aggregation and mode choice | 37.05 s | 442.01 MiB |
| Above + approximate route reuse | 33.48 s | 452.14 MiB |

Reuse adds a 3.57-second saving, or 9.63% less time than the exact combination, while increasing observed maximum process RSS by 10.13 MiB. The exact combination matched baseline assignment and profile hashes; reuse did not.

Measured reuse errors versus the Wasm baseline:

- Daily revenue: **-1.649%**; transit share: **-0.538 percentage points**.
- Worse perceived journey cost for **7.01%** of the directional population.
- Maximum positive perceived-cost difference: **26,577 seconds** (7.38 hours); maximum relative difference: **836.2%**. These maxima need not refer to the same journey.
- Population-weighted positive cost error: mean 53.96 seconds, p95 279.14 seconds, p99 828.31 seconds. This distribution includes zero errors and only records with a populated `transitTime` value in both variants; that field represents perceived seconds.
- **138 directional assignment records** changed whether `transitTime` was populated. This measures output-field nullness, not proven network disconnection; a missing recorded transit leg must not be reported as a newly disconnected station pair.

The bounded menus stayed within their configured caps. Peak retained edges were 72,057 for Chiba, 56,819 for Tokyo, and 45,414 for Kanagawa; each reached the 4,096-menu limit. These are references to existing graph edges, not copies of complete graph/search state. They do not bound the evaluator's total memory, its allocation rate, or the game's process memory. The RSS result provides no evidence that this approximation helps the user's OOM problem.

Nine focused tests cover exact schedule replay and materialization on a single-route fixture, differing access/egress, joining and leaving subpaths, timetable closure fallback, router replacement, disconnected/empty/incumbent-bound queries, retention caps, and detection of a real cost error after the best line changes. Passing these establishes replay behavior and bounds on retained cache state; it does not establish approximation quality.

The poor worst-case journey errors, changed finance/ridership, and small incremental speed benefit reject this candidate for deployment. The large speed reduction in the selected exact combination comes from removing other repeated work, so route approximation is unnecessary for that gain.
