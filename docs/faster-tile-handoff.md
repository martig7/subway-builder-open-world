# Faster Japan tile handoff

The September 20 Chiba-to-Tokyo capture took at least 123.816 seconds from
native navigation to map attachment, excluding staging. The first mod demand
worker started more than 104 seconds after navigation. Tokyo's first active
preparation was refused by memory admission; its later 23.809-second calculation
was the first completed preparation, not a repeated successful calculation.
See [the captured sequence](routing-result-retention.md).

## Implementation

The fourth optimization, `renderer-local-native-handoff-v1`, removes the full
save round trip through Electron's object bridge. The destination's existing
native loader consumes a one-use renderer-local snapshot. A structured-clone
channel stages one recovery copy through the existing native pending-save API
before navigation starts. This preserves recovery while avoiding the costly
full graph transfer through `contextBridge` in either direction. See
[the host bridge and installation procedure](native-save-load-performance.md#renderer-local-tile-handoffs).

Explicit native save selection supersedes local staging. Exact owner IDs,
serialized native mutations and cancellation guards prevent abandoned or late
handoffs from overwriting a newer selection. Consuming or cancelling the slot
releases its graph reference. The runtime also drops its separate verification
snapshot before destination profile and commute preparation. The first capture
can borrow live native arrays, so that verification snapshot remains an
independent clone. Unsupported hosts retain the previous transport; uncertain
fast-stage failures abort without retrying a potentially stale save.

`native-handoff-exact-reuse-v4` observes the native loader for one explicitly
staged navigation. The recovery marker, transition, source/destination, save
identity and session must match. It compares the staged authority with the
loader payload, the canonical network, and the resulting native store. Matching
IDs or counts alone cannot enable reuse. An uncertain or changed value takes
the normal restoration path, with a compact mismatch reason in diagnostics.
The known native v-merge occupancy reset and loader pause are handled explicitly;
the omitted infrastructure billing cursor is restored after verification.
Live-state comparison also handles the native loader's nullish defaults for
disabled yards and an absent track-edit session. Payload comparison remains
strict, and nonempty yards or synthesized edit sessions cannot pass as defaults.
Successful reuse skips the second native `loadSave` and canonical snapshot
assembly while still rebuilding the destination's presentation.
The native city-loaded event precedes its pending-save loader. Completion now
waits for that first loader outside the runtime queue, then binds the restored
native session identity. A timeout keeps the clock held and offers a retry;
it cannot start a competing restore while the first load is outstanding.
The exact comparator uses a reusable path stack and a bounded 8,192-pair cache;
it does not allocate path strings and key arrays for every matching object.
Its work and recursion limits conservatively refuse reuse.

`tile-simulation-handoff-v1` separates map readiness from simulation readiness.
The destination map attaches and navigation completes before demand/finance
preparation is scheduled. A separate tick hold spans staging, destination loading
and deferred preparation. Another tile switch cannot overtake that work.

An explicitly enabled Ultra-high-speed mode carries its intent through this
same-session navigation. Source cached time settles and train anchors rebase
once before snapshot capture; observed native work drains before loading the
destination. While the hold owns cached-mode navigation, native commute/path
actions are suppressed and native repair avoids building requests that would
be discarded. Destination Wasm assignments are prepared/published once, and
their finance profile is reused by background preparation. Normal-mode
navigation retains native commute repair. Heavy workers remain serialized and
the existing memory admission limit remains in force.

Failed preparation keeps time held and can be retried through the existing
Ultra-high-speed toggle. Service edits during preparation join replacement
work. An unrelated save load or ended session cancels the pending transition,
releases the observer's snapshot, and prevents delayed restoration or demand
results from publishing into the replacement session. Loading a save or
restarting restores the saved Ultra preference only after the new network's
startup preparation; the old handoff cannot enable it.

The cached wrapper is generation `open-world-cached-simulation-v17`; prior
wrappers are replaced on reload. Source cache and frozen-train references are
released after settlement. The handoff keeps compact lifecycle diagnostics,
not an extra assignment cache. The existing native save authority and disk
demand cache formats are unchanged.
Tile bookmarks also discard topology before cloning their retained fields,
avoiding a complete temporary network copy during source staging.

`canonical-network-presentation-v1` builds only the geometry, ownership and
classification needed to show the canonical network. It avoids cloning the
native repair state and embedding full train and financial histories in a
presentation manifest. Native saves and the canonical network retain authority;
the compact manifest cannot be used to restore topology.

## Verification of the first three changes

The shared suite passes 1,072 tests and the Japan consumer suite passes 7.
Behavioral regressions cover verified reuse and conservative fallback, deep
topology and ledger mismatches, previous observer/wrapper replacement, native
work draining, map readiness before finance, paused/running mode intent,
memory-error retry, edits during assignment calculation, and unrelated-save
cancellation. Cancellation tests exercise package loading, adoption, validation,
the adapter's own asynchronous boundaries, and real unrelated-save adoption.
The lifecycle tests reproduce the native city-before-save event order, including
the synchronous game-loaded callback inside the asynchronous native loader.
The active consumer is `local.japan-open-world`, built from
`prototype/japan/mod`. The built and installed bundles have matching SHA-256
`43DD250C0B25F5C04D93BFF6EF8B7E6A0742B743744D992E8B59A50DB50E1043`
and UTC timestamp `2026-09-20T18:09:18.8006314Z`. Both contain verifier v4,
compact presentation v1, simulation handoff v1 and cached simulation v17.
The configured PMTiles service returns HTTP 200 with
`X-PMTiles-Server-Version: native-pmtiles-directory-v4`.

An isolated benchmark used the September 20 12:27 Okayama native save, containing
1,323 stations, 8,484 tracks, 293 routes and 1,046 trains. Separate Node processes
with a 3 GiB heap limit loaded the same input and built the Japan presentation:

| Projection phase | Previous path | Compact presentation |
| --- | ---: | ---: |
| Build time | 5,782 ms | 2.56 ms |
| Process peak RSS, including input parsing | 2,430 MiB | 1,182 MiB |
| Presentation manifest bytes | 66,122,542 | 1,036,750 |
| Full clone calls during projection | 14 | 0 |

Map output, metadata and visible entity IDs matched. These are isolated
projection measurements, not whole-game memory or end-to-end handoff results.
The normal legacy projection path remains available to its existing consumers.

An earlier live validation build exhausted V8 memory after the first native
destination load and before routing began. Its last fresh heap sample was
2.73 GiB with another 1.01 GiB of backing storage; the precise failing allocation
was not captured. That result prompted the compact presentation path and
allocation-bounded verifier above. Autosave was temporarily disabled during
subsequent validation to avoid overlapping another large native save transfer.

The subsequent Okayama-to-Hiroshima switch completed without OOM. Exact hashes
matched for stations, tracks, track groups, station nodes/groups, signals,
routes, trains, financial history, route finances and owned train count. Session,
clock, money and infrastructure billing cursor also matched. The map attached
at 365.919 seconds; simulation was ready at 392.232 seconds, 26.298 seconds later.
Ultra-high-speed intent was retained and the clock did not advance. Hiroshima's
37,519-pop assignments were prepared once and reused as `live-profile` by finance.
The second worker job evaluated the formerly active Okayama tile's 32,910 pops.
All mod demand workers were released afterward and the map was loaded/attached.

That run conservatively fell back because native `generateSave` writes own
undefined values for disabled yards, while `loadSave` restores false/empty.
Verifier v4 handles those documented defaults. The return-trip result below
verifies the corrected reuse path. The outbound timing is not a controlled
comparison with the earlier run: autosave and verifier behavior differed.

The final Hiroshima-to-Okayama run explicitly recorded
`native-handoff-exact-reuse-v4`, `reused: true`,
`reason: verified-staged-native-load`, and `native-restore-reused`. There was no
second native restore. Exact state hashes and all scalar authority checks above
matched the original save again. The map was loaded and attached, Ultra mode
was ready, and all mod evaluator requests completed with no active worker.
Neither switch with compact presentation crashed.

| Final return-trip phase | Time |
| --- | ---: |
| Staging | 154.465 s |
| Native first-load wait | 149.125 s |
| Completion transaction after native loading | 6.480 s |
| Destination presentation build | 2 ms |
| Map ready from measured handoff start | 324.569 s |
| Deferred simulation preparation | 26.512 s |
| Simulation ready from measured handoff start | 351.091 s |

Before the fourth optimization, this large save's handoff remained slow: staging plus
native loading still account for about 86% of total time. The installed save
read bridge recorded a native fallback on the staged graph. Avoiding the large
Electron save transfers was the next substantial target; routing was idle during
those waits. No end-to-end speedup ratio is claimed from the different-direction
and differently configured captures.

Validation used the same native save session and paused clock throughout, with
no construction edits. A subsequent cleanup using native `reloadWindow` hit
another confirmed V8 OOM at 18:18:54 UTC: the renderer process was reused, and
automatic recovery then stranded the native map's load callback. This is a
material remaining limitation, despite both completed tile-switch checks.
A full game-process restart was used to restore the untouched original Okayama
save. Ultra mode, camera and autosave were restored to their original settings.

This change does not replace native autosave transport or make assignment
publication fully streaming. Neither lower routing-worker memory nor a
successful round trip establishes that every source of the earlier OOM is gone.

## Renderer-local handoff verification, September 20

The same paused Japan network was loaded in a fresh game process with the v2
host bridge and the rebuilt `local.japan-open-world` consumer. The round trip
used Ultra-high-speed mode, with native autosave temporarily disabled as in the
preceding handoff benchmark. No topology, ledger, clock or construction edits
were made. These are individual local runs, not a controlled multi-run estimate.

| Hiroshima to Okayama phase | Previous native transport | Renderer-local handoff |
| --- | ---: | ---: |
| Source staging | 154.465 s | 25.747 s |
| Native first-load wait | 149.125 s | 7.533 s |
| Map ready | 324.569 s | 51.108 s |
| Deferred simulation preparation | 26.512 s | 24.069 s |
| Simulation ready | 351.091 s | 75.199 s |

The measured return trip used 78.6% less total time. Its native save stage,
including snapshot isolation and the acknowledged recovery copy, took 7.110 s.
The outbound Okayama-to-Hiroshima switch reached map readiness in 42.059 s and
simulation readiness in 65.872 s; its native save stage took 7.028 s.

Both switches reported `nativeSaveTransport: renderer-local`, exact verifier
v4 reuse and no second native restore. The host recorded two stages and two
consumptions, zero failures, and zero retained payloads afterward. JSON reads
remained at the one original-file load, and native full-object reads remained
zero across both switches. Maps and styles were loaded and the original
Okayama camera returned. All 41 evaluator requests completed, every evaluator
worker was released, and simulation intent remained enabled through each switch.

Exact SHA-256 comparisons matched stations, tracks, track groups, station
nodes/groups, signals, routes, trains, financial history, route finances and
owned train count after each direction. Native session, paused clock, money
and the infrastructure billing cursor also matched the original save.

Neither switch OOMed. Sampled main-renderer V8 heap peaks were 2.15 GiB outbound
and 2.59 GiB on return; the return sample also had 0.81 GiB of backing storage.
Renderer-process private memory peaked at 4.17 GiB and 5.10 GiB respectively.
Heap sampling had gaps up to 16.4/17.9 seconds during blocked work, so these are
observed peaks, not a proven upper bound. The final sampled V8 heap settled to
about 1.64 GiB, with 0.86 GiB of backing storage. This change eliminates the
slow object-bridge round trip and releases its owned payload; it does not prove
that long-session memory growth, native autosave or renderer-reload OOMs are fixed.

Validation passes 1,104 shared-platform tests and 7 Japan behavioral tests.
Regressions cover local consumption, missing capabilities, metadata validation,
delayed message delivery, newer native selections, failed/uncertain backups,
timeouts, cleanup retries, stale runtime staging, borrowed snapshot isolation,
early snapshot release and safe host-patch upgrades with rollback.

The Japan built/installed bundle SHA-256 is
`BD8EC7F0A6771ABF28AFA25E8ADE4FC17B6D175C114FF79151E8F868AD511452`,
with matching UTC timestamp `2026-09-20T18:46:01.5501369Z` and the local-handoff
marker. The installed native archive SHA-256 is
`d5549a5815a02146713f4c293e63a4f1f48d1ce7e1f4f08804953ba0d7ab4214`;
its verified original backup is retained. The PMTiles service remains HTTP 200
with `native-pmtiles-directory-v4`. Live diagnostics proved the v2 host and new
consumer were executing. Detailed captures are Git-ignored under
`.analysis/faster-tile-handoff/local-v1-*`.

After benchmarking, autosave was restored to five minutes with five retained
autosaves, and Ultra mode was returned to its original off state. A full process
restart restored the unchanged original Okayama save and released the benchmark
session's heap. Exact state comparisons passed again after that reload; the
game remained paused at its original clock and balance.
