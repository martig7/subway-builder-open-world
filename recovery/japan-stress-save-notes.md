# Japan save construction experiment

Status on 2026-09-07: experimental candidate, not a validated playable network.
Active installed mod: `local.japan-open-world` v0.5.0, consumer `prototype/japan/mod`.
No mod bundle was changed or installed during this experiment.

## Observed native container

Based on the local eight-station Tokyo playtest and the installed game renderer.
All numeric header fields below are little endian. These are observations, not
an official or complete format specification; the writer retains template bytes
whose meaning has not been established.

| Offset | Meaning |
| --- | --- |
| 0 | `METR` magic |
| 4 | container version, observed 0 |
| 8 | header length, observed 4096 |
| 12 | auxiliary JSON length, observed 2 (`[]`) |
| 16 | preview offset |
| 20 | PNG preview length |
| 24 | gzip payload offset |
| 28 | gzip payload length |
| 32 | uint64 timestamp in milliseconds |
| 40 | save name, 256-byte UTF-8 field |
| 296 | city code, 32-byte UTF-8 field |
| 328 | session ID, 64-byte UTF-8 field |
| 392 | metadata JSON; full reserved boundary remains unverified |

The payload decompresses to `{mainSave, autosaves}`. `mainSave.version` is 4.
Topology lives in `mainSave.data`: tracks, track groups, stations, station groups,
platform nodes (`stNodes`), signals, routes and trains. Route path steps refer to
track IDs, lengths and signals. The known eight-station route has 14 travel legs
and 15 platform entries: its first node is repeated at the end to close the loop.
Terminal visits use one platform each; intermediate stations use both directions.
`timeConfig.timeSpeed` must be a string enum, not a numeric multiplier.

## Candidate generator

`build-japan-stress-save.py` accepts `--template`, `--data-root`, `--bundle` and
`--output`. It refuses to overwrite its output or modify input files. The template
must be the known eight-station Tokyo playtest; this is not a generic save editor.
Run Python normally, without `-O`, because integrity checks use assertions.

The generator selects 12 cross-tile and 12 local corridors from installed demand,
aggregating OD mass and avoiding nearby duplicates. It clones the tested route
topology, remaps UUIDs, and transforms geometry into each corridor. The candidate
has 192 stations, 24 routes and provision for up to 384 ten-car trains at peak.
It starts paused at 05:00 with no live trains or recorded riders. Capital of
$30 billion and rolling stock are seeded, not earned. Cached timings are estimates
and need native validation. Separate cloned lines do not yet have explicit merged
interchange station groups. Cross-tile route geometry does not prove actual
cross-tile transit use.

## Import observations and remaining validation

Local outputs are ignored under `.analysis/`:

- `japan-kanto-stress.metro`: first candidate had invalid numeric time speed.
  Import returned silently to the existing save menu.
- `japan-kanto-stress-v2.metro`: corrected string speed (`fast`), SHA256
  `d85b3d1f5e518f6a138c3a832f82383abb5875a276b93804b3d9515c900fd8ee`.
  Selected through Import Save File, with its full filename visually verified in
  the native picker. Opening it produced a persistent blank white game window.
- Matching `.report.json` files record the selected OD corridors and metadata.
- `japan-stress-captures/` contains timestamped GDI screenshot evidence.

Generation passed container round-trip equality, entity ID uniqueness, closed
route/leg counts, and track/node reference checks. These checks do not establish
native runtime correctness. The white screen's cause is unresolved: it could be
another generated data inconsistency, native loading behavior, or mod behavior.
It must not be reported as a confirmed mod defect.

The original Tokyo playtest remains at
`D:/SubwayBuilder/codex_tokyo_playtest_2026_09_06_06f526b7352541d390813e64a323ce65.metro`.
No gameplay took place after candidate import. Automatic approval review denied
closing/restarting the blank game pending explicit user authorization.

Next: recover with runtime diagnostics, validate the load against the native
schema and loader, verify all routes survive validation and trains move, measure
actual morning-peak ridership and cross-tile journeys, then measure simulation
throughput, memory, UI responsiveness and mod diagnostics. No performance or
strong-use conclusion is available yet.
