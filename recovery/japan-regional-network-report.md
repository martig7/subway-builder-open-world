# Japan Regional Railway — Tokyo to Kobe

Built and played on 2026-09-07 with installed `local.japan-open-world` v0.5.0.
Its consumer source is `prototype/japan/mod`; this task did not alter, rebuild,
or install mod runtime code.

## Delivered save

**Japan Regional 316 - Tokyo to Kobe**:

`D:/SubwayBuilder/japan_regional_316___tokyo_to_kobe_66ee87b2e9ee4d2e8134e66c9d7ac1a1.metro`

Native file SHA256:
`846b18707c4aa3f82a3f5b060f8637cef733b57dd12c187b41cdab18fb5415df`.
An additional local copy is at `.analysis/japan-regional-final.metro` (ignored).
The game remains open, paused in Osaka at Day 1, 16:32:16, with 233 active trains
and 80,315 lifetime riders. The native file was decoded independently after
the game wrote it; its counts, time, rider total and topology passed validation.

## Network

- 316 platform stations grouped into 274 named hubs, compared with the prior
  save's 192 stations. There are 34 interchange hubs and 53 services (previously 24).
- Greater Tokyo, Yokohama, Shizuoka, Hamamatsu, Nagoya, Gifu, Kyoto, Osaka,
  Sakai and Kobe are connected by a chain of Tokaido regional services.
- 37 commuter-rail, 11 heavy-metro, 3 light-metro and 2 light-rail services.
  These use the game's native rolling stock, with 8, 10, 4 and 9 cars respectively.
- 13 local/rapid pairs use identical physical tracks. Rapids stop at four
  stations each way; locals serve all eight. Joban and Sumida branch services
  additionally share four physical stations and their connecting trunk tracks.
- 646 track segments carry multiple services. Total physical track length is
  approximately 1,722 km, counting both directions separately, not route-km.
- Kyoto and Osaka each group four platform stations. Sannomiya, Ueno, Sakae
  and Shin-Imamiya each group three. Metro and elevated light-metro platforms
  use different elevations from ground-level regional rail.
- Each service uses one platform at each terminal. Intermediate stations have
  directional platforms. Rapid services share turnbacks with their local service.

This is a fictional, geographically inspired network, not an exact reconstruction
of existing Japanese railway alignments. Named hubs and regional structure were
informed by [JR East maps](https://www.jreast.co.jp/multi/downloads/),
[JR Central route maps](https://railway.jr-central.co.jp/route-map/index.html),
and [JR West route maps](https://www.westjr.co.jp/travel-information/en/plan-your-trip/routes-schedule/).
Geometry uses approximate station anchors and smooth connections, including
fictional branch and feeder services. It does not reproduce surveyed curves,
terrain engineering, real operator timetables or Shinkansen rolling stock.

## Native playtest

Imported using **Import Save File** and the native Windows chooser. All 316
stations, 53 routes and 2,294 tracks survived the import and switches from Tokyo
to Aichi and then Osaka. All four rolling-stock types spawned and moved.

Morning fleet sample: 122 commuter trains, 88 heavy metros, 18 light metros and
12 light-rail trains, 240 in total. Every sampled route had no disruption, and
no sampled train had gone ten simulated minutes without movement.

| Active tile and time | Trains | Tick median | Tick p95 | Largest sampled tick |
| --- | ---: | ---: | ---: | ---: |
| Tokyo, 07:49 | 240 | 36.7 ms | 58.1 ms | 278.8 ms |
| Aichi, 09:04 | 240 | 38.3 ms | 52.1 ms | 329.3 ms |
| Osaka, 11:01 | 160 | 42.2 ms | 67.8 ms | 328.5 ms |

These are simulation timings at `fast`, not frame rates or controlled benchmarks.
The Aichi sample advanced 3,848 simulation seconds in 56.2 wall seconds.
This was a daytime playtest, not a long-duration soak.

The mod found 2,981 transit-viable cross-tile demand groups out of 33,553 evaluated.
That is modeled demand suitability, not observed native passenger boardings.
Capital ($75 billion) and rolling stock were deliberately seeded; ridership and
financial history started at zero. Financial results include the mod's existing
off-tile model and must not be interpreted as an earned campaign balance.

Capacity warnings appeared on Kyoto–Osaka Local and Sakai Suburban Local. Their
fleet schedules were increased to 6/4/3/2 trains across demand levels. The Kyoto
warning cleared and four local trains were confirmed running after the change.
Capacity alerts returned during the afternoon on both services. The final save
therefore remains a playable network with room for further capacity balancing,
not a claim of fully optimized operations. At the final pause there were zero
route disruptions and zero trains stationary for ten simulated minutes.

## Mod observations

- Cross-demand and all-47-tile finance recalculation took 12.4–13.2 seconds on
  startup/tile changes, even with unchanged network geometry. All profiles
  reported ready; none reported failed or unavailable. This remains a performance
  investigation target.
- The loading overlay repeatedly displayed the previous save's “192 stations ·
  24 routes” while loading this 316/53 network. Final state was correct. This is
  a reproducible stale loading-label observation; ownership was not diagnosed.
- A fresh 55-second console observation in Osaka recorded one slow-autosave
  warning (1,482 ms), with no new exceptions or track-length cache warnings.
- Historical console replay contained recovery-staging and stale-source messages;
  these were excluded from the fresh monitoring window and are not attributed
  to the new network.
- Distant land rendering retains conspicuous polygon patches. This observation
  does not establish a new regression caused by this save.

## Reproduce and validate

`japan-regional-plan.json` contains named coordinates and 40 eight-station
corridors. `build-japan-regional-save.py` clones the native eight-station topology,
preserves terminal crossovers, remaps IDs, builds smooth paths, merges shared
trunk topology, groups interchanges and writes a separate METR container.

```powershell
python recovery/build-japan-regional-save.py `
  --template 'D:/SubwayBuilder/codex_tokyo_playtest_2026_09_06_06f526b7352541d390813e64a323ce65.metro' `
  --output './.analysis/japan-regional-new.metro'
```

The command refuses to overwrite a file. UUIDs and timestamps are fresh on each
run. The source template is a local prerequisite, not committed game content.
The report sidecar records counts, shared tracks, path gap maximum and SHA256.

Validation checks native geodesic lengths, compatible track/train types, ID
uniqueness, path references, cyclic service topology, exact shared branch node
counts and one connected passenger graph including all station-group transfers.
The generated paths had zero endpoint gaps. Container encode/decode round-trip
passed, as did the existing two geodesic-distance regression tests.
