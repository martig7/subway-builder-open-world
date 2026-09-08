# Tile-switch speed investigation, 2026-09-08

Japan consumer: `prototype/japan/mod`, manifest `local.japan-open-world`.
Production changes require no explicit GC and do not preload another city's data.

## Direct native session binding

The preceding live traces spent 3,951–4,308 ms between lifecycle transition start
and identity binding completion. Each native route load creates a new session
key. Reading that key before an explicitly forced binding missed IndexedDB and
fell back to decoding the large legacy scoped storage document.

`direct-native-save-binding-v1` writes the authorized forced binding directly,
then reads it back to verify the winner. Ordinary bindings retain their existing
conflict protection and legacy lookup. No large cache or migration rewrite was
added. A regression test failed on the former legacy read and now passes.

Two live switches (Osaka → Kanagawa → Osaka) passed with exact network-ID hashes,
money, elapsed time and paused state preserved. Binding took 5 ms and 30 ms.
Total times were 27,231 and 27,007 ms.
Other loading work varied, so these totals alone do not establish a four-second
end-to-end gain. The isolated binding delay was eliminated. Original tile,
camera and pause state were restored; no forced collection or reload occurred.

Platform tests: 712 passing; Japan tests: 6 passing. Both built and installed
bundles contained the marker and SHA-256
`23F85E2A59752FE31556ECA024D9284376D76678F5A5C26D6E5E2AE2DC4CAF05`.
PMTiles returned HTTP 200, `native-pmtiles-directory-v4`. Raw local evidence:
`.analysis/identity-speed-check.json` (Git-ignored).

## Assemble and clone native snapshots once

`native-tile-snapshot-copy-v1` assembles destination city metadata, preferred
native finances, fallback fields, and completed journey history before making
one isolated clone. Previously restoration cloned the original snapshot,
individually cloned replacement finance fields, cloned route financials again
for normalization, and could clone the entire result again for city rebinding.
The template-based capture path now also binds city metadata before its clone.
All mutable data handed to the native loader remains isolated from the source.
No full-save cache, shared mutable loader payload, parallel city preload or
explicit collection was introduced.

Regression tests verify that overwritten history is not traversed, retained
history is traversed once, finance precedence and legacy journey decoding stay
correct, and mutations to restored routes/finances/journeys cannot reach inputs.

A separate Node benchmark reproduced the old preparation sequence and checked
deep equality with the new output. With 38,496 ledger entries and 53 routes with
2,000 history entries each, six alternating samples had median preparation times
of **783.25 ms before and 181.49 ms after (4.32× faster)**. This is a synthetic
preparation benchmark, not a measured whole-switch gain or a retained-byte claim.
Raw data: `.analysis/snapshot-copy-benchmark.json`.

The live Osaka → Kanagawa → Osaka test passed with both markers active and all
network/finance/clock invariants unchanged. Camera, original tile and pause state
were restored; there was no renderer reload or OOM. Results:

| Build | Destination | Binding | Native restore phase | Full switch |
| --- | --- | ---: | ---: | ---: |
| Direct binding | Kanagawa | 5 ms | 3,192 ms | 27,231 ms |
| Direct binding | Osaka | 30 ms | 3,157 ms | 27,007 ms |
| Both changes | Kanagawa | 33 ms | 3,521 ms | 28,116 ms |
| Both changes | Osaka | 27 ms | 3,201 ms | 31,605 ms |

**These live results do not demonstrate an end-to-end speedup.** The second pair
had longer native-navigation and post-restore refresh intervals; even the
identity-only pair spent 7.4–7.8 seconds in the profile/commute/verification
interval. The synthetic benchmark overlapped part of the first switch of the
second pair, further limiting the timing comparison. The second pair's main
heap at completion was 2,003,888,164 and 1,937,808,880 bytes, versus 1,755,351,348
and 1,811,981,072 for the first pair. These uncollected, accumulated-session
measurements do not establish a process-memory reduction. The justified benefit
is removal of the legacy read and provably redundant clone work, not a promise
that the full switch is faster or every OOM is eliminated. The remaining native
load and commute-refresh work needs separate attribution before further changes.

Final platform tests: 715 passing; Japan consumer tests: 6 passing. Installed and
built Japan bundles both contain both version markers and SHA-256
`49329E83615904177DD43C552386C78950B1582FF7CC2CB3BB329A5C6299C0F3`,
6,279,256 bytes, timestamp 2026-09-08 20:56:14 UTC. Runtime markers were verified
in the actual completed-switch records. Raw live data:
`.analysis/snapshot-speed-check.json` (Git-ignored).
