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
money, elapsed time and paused state preserved. Binding took 5 ms on the first
switch; the second result is recorded below. Total times were 27,231 and 27,007 ms.
Other loading work varied, so these totals alone do not establish a four-second
end-to-end gain. The isolated binding delay was eliminated. Original tile,
camera and pause state were restored; no forced collection or reload occurred.

Platform tests: 712 passing; Japan tests: 6 passing. Both built and installed
bundles contained the marker and SHA-256
`23F85E2A59752FE31556ECA024D9284376D76678F5A5C26D6E5E2AE2DC4CAF05`.
PMTiles returned HTTP 200, `native-pmtiles-directory-v4`. Raw local evidence:
`.analysis/identity-speed-check.json` (Git-ignored).
