# Incremental save measurements — Japan, September 14, 2026

Record and field reuse removes nearly all capture payload during the measured
paused construction intervals. In the user's high-speed run, however, about
134.4 MB of changed values remained out of a 179.7 MB snapshot. The game changes
large demand and timetable structures as simulation advances; money and clock
are not the only volatile fields.

This is an offline comparison of real autosaves, not an implemented incremental
save benchmark. It supports a hybrid writer with bounded buffers and a full-save
fallback. It does not establish that high-speed autosaves can become instant.

## Capture and method

Active consumer: `prototype/japan/mod`, manifest `local.japan-open-world`.
The same native session was observed in `JP_TOKYO_MAINLAND` and later `JP_PREF_12`.
Comparisons were made within each Tile View. The cross-tile transition was excluded;
its 191 MB to 120 MB size change must not be attributed to a writer optimization.

Thirteen completed native/prototype files were copied from `D:\SubwayBuilder`.
The game, installed mod and tile services were unchanged. The user had disabled
the experimental tile-server writer, and that setting remained disabled. Current
gameplay measurements used ordinary native autosaves.

The user reported enabling high-speed mode and editing. The later runtime reported
cached simulation `ready`, version `open-world-cached-simulation-v13`. The high-speed
save records the simulation clock advancing from 223,516,800 to 223,614,000 seconds:
**27 game hours over approximately five real minutes**. The earlier construction
intervals have identical clock values and are labeled paused, even though their
station, route and financial data changed.

The [offline diagnostic](../../open-world-platform/native/tools/OpenWorld.SaveMeasurements/README.md)
streamed each gzip payload and fingerprinted sections, individual array records,
and fields within trains. All comparisons used for results below have complete
fingerprint lists and unique matching keys. Six no-change intervals, including
one crossing from the native writer to the prototype writer, had byte-identical
`mainSave.data` despite repeatedly writing a full snapshot.

All MB below are decimal, uncompressed UTF-8 JSON bytes. The changed-value estimate
uses changed records for arrays, changed fields for trains, and changed leaf
sections for remaining values. Unchanged parents are not counted twice. It excludes
the envelope, property names/framing, and deletion/order instructions, so an actual
patch would be larger. Percentages concern capture payload, not elapsed time.

## Results

Times are America/New_York (EDT); the first two intervals start September 13.

| Interval and observed activity | Full JSON | Whole changed data sections | Changed values | Payload reduction before patch overhead |
| --- | ---: | ---: | ---: | ---: |
| 23:50–23:55, paused, 967 → 972 stations | 190.79 MB | 18.50 MB | 0.160 MB | 99.92% |
| 23:55–00:00, paused, 972 → 985 stations | 191.00 MB | 44.54 MB | 0.245 MB | 99.87% |
| 00:20–00:25, paused, +8 stations, +24 routes | 120.32 MB | 70.34 MB | 2.011 MB | 98.33% |
| 00:25–00:30, paused, +11 stations and other edits | 120.36 MB | 44.35 MB | 0.109 MB | 99.91% |
| 00:30–00:35, user-reported high speed, +27 game hours | 179.73 MB | 151.13 MB | 134.362 MB | 25.24% |

Exact changed-value totals in row order: 159,716; 244,923; 2,011,446;
108,926; 134,362,221 bytes. The compressed high-speed file was 22,863,492 bytes;
that compressed disk size must not be compared directly with uncompressed deltas.

### Why granularity matters during construction

Between 00:20 and 00:25, 854 of 946 train records changed. Replacing whole changed
trains would send 22,741,485 bytes. Replacing their changed fields requires
1,305,632 value bytes: mostly `windows` (1,300,931), with small changes to
`currentStComboInfo`, `routeId`, and `timings`. Most timetable payload was unchanged.

Similarly, a five-station edit changed 18.50 MB of sections but only 159,703 bytes
of array records, plus 13 bytes of small data values. Financial history provides
another example: later construction changed tens of bytes in current-hour totals,
while its roughly 15 MB entry history stayed byte-identical.

Cheap markers should therefore identify records and sometimes fields, rather than
marking an entire `trains`, `tracks`, or `financialHistory` collection dirty.
Changes also reordered arrays: preserving order requires additional metadata even
when record values can be reused.

### What changed during high speed

| Component | Changed record/field values | Observation |
| --- | ---: | --- |
| Completed commutes (`compressedDemandData.c`) | 97.322 MB | 192,375 new identities, 85,450 removed; only 18 unchanged records |
| Pop demand rows (`compressedDemandData.p`) | 11.083 MB | All 56,322 rows changed |
| Train fields | 24.900 MB | All 942 remaining trains changed; four were removed |
| Route finances (`routeFinancials.byRoute`) | 0.523 MB | Counted as a whole changed child section |
| Signals | 0.397 MB | 538 records changed |
| Demand point rows | 0.124 MB | 1,880 records changed |
| Financial history entries | 0.0067 MB | 27 appended entries; existing entries reused |

Train `timings` alone accounted for 23.624 MB of changed field values in this run.
The construction result that most timing data can be reused does not hold across
this high-speed interval. Completed commute keys contain temporal information;
new identities do not prove every nested route/path byte is novel. Deeper semantic
deduplication might improve these results and was not measured here.

The native log reports `Autosave slow: 34636ms` for the 00:35 save. This is the
existing writer's completion duration, not a benchmark of incremental capture or
a proven 34.6-second continuous UI stall. One read-only debugger status query
timed out during this save and succeeded afterward. The snapshot was successfully
published; this measurement did not observe a renderer crash.

## Memory and implications

The final offline profiler peaked at about 48 MiB RSS and took approximately
1.8–2.6 seconds per snapshot. Comparison uses eight on-disk identity partitions
and peaked at 93,978,624 bytes RSS (89.6 MiB) on the high-speed pair under a 256 MiB
managed heap cap. An earlier monolithic comparison hit that cap and exited; the
partitioned version completed the same pair. No snapshot graph was copied into
the renderer for these measurements and no persistent measurement process remains.

For a future incremental writer, the paused-edit results support keeping only
dirty IDs/revisions in the renderer and reusing the previous snapshot on the tile
server. The high-speed result rules out budgeting on the assumption that each
checkpoint is always a few small scalars. Retaining all changed values at once
could already require roughly 134 MB in UTF-8 form for this run, with additional
cost for JS objects, strings, transfer copies and writer bookkeeping. These byte
counts do not measure the resulting JS heap increase.

The design should bound transfer buffers and queued checkpoints, replace or
backpressure redundant work, and use a consistent checkpoint before allowing
mutations to resume. Disk reconstruction/compression can continue afterward in
the tile server. Diffing two fully materialized renderer snapshots would retain
the full traversal cost and increase peak memory, so these measurements support
mutation tracking plus server-side reuse instead.

This optimization looks strong for construction sessions. At the tested
record/train-field granularity it saves about one quarter of high-speed capture
payload; reducing that further needs work on demand/commute and timetable
representation. It remains necessary to benchmark actual snapshot latency,
peak renderer heap, restore correctness and ordinary-speed play before choosing
buffer sizes or claiming a particular autosave speedup. One high-speed interval
is not a worst-case memory bound.

Local evidence is Git-ignored under `.analysis/save-change-measurement`: `inputs/`,
`v2-profiles/`, `v2-comparisons/`, and `result-summary.json`. The accepted high-speed
comparison is `high-speed-partitioned.json`; the earlier `high-speed.json` was
truncated and must not be used. Source seam validation is the tool's `self-test`;
no runtime source changed, so consumer rebuilding/installation was unnecessary.
