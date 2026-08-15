# Milestone 2 — six-package density pilot

**PASS** for the measured feasibility gates. This is a construction/load proxy, not an in-game renderer benchmark.

## Measured packages

| Tile | Buildings | Roads | Package MiB | Build min |
| --- | ---: | ---: | ---: | ---: |
| `NY_CP00_RP00` | 2,612,022 | 233,143 | 333.5 | 83.6 |
| `NY_CP00_RP01` | 386,437 | 38,461 | 72.3 | 25.3 |
| `NY_CP01_RP00` | 855,438 | 77,204 | 136.3 | 36.7 |
| `NY_CM01_RP01` | 160,374 | 17,343 | 32.6 | 16.5 |
| `NY_CM01_RP02` | 175,684 | 15,301 | 28.8 | 15.4 |
| `NY_CM01_RP03` | 47,234 | 4,841 | 11.8 | 14.7 |

## Gates

- Statewide installed projection: **1.79 GiB**; 35% conservative case **2.42 GiB** / 12 GiB — **PASS**.
- Peak one-process pipeline RSS: **13.95 GiB** / 16 GiB — **PASS**.
- Largest package: **333.5 MiB** / 512 MiB pilot active-package budget — **PASS**.
- Warm load-proxy p95: **2.82 s** / 5 s — **PASS**.
- One-day traversal: **93,470 cohorts / 4,714,269 workers in 0.28 s**.
- Ten-autosave retention: **10 retained after 11 writes**, 831 bytes reclaimed.

## Interpretation

The statewide estimate assigns each normal tile to the closest measured pilot by log LODES activity-worker density. It retains an independent PMTiles archive per tile, so it is conservative relative to the planned shared archive. The warm-switch test performs the expensive immutable-data work (JSON parsing and gzip inflation) against a warm filesystem cache, but it does not measure Electron renderer reconstruction; that remains a Milestone 3 integration check.

Routing status: **complete**.
