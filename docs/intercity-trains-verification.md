# High-speed rail and maglev delivery

Verified September 9, 2026 (local time) against Subway Builder 1.7.0.

The active runtime identified itself as `local.japan-open-world`, with city
`JP_PREF_26`. Its consumer is `prototype/japan/mod`. Train definitions and
registration live in `open-world-platform/src/runtime/intercity-trains.js`;
every consumer using the shared startup receives them when rebuilt.

The game registers **High Speed Rail** (`open-world-high-speed`) and **Maglev**
(`open-world-maglev`) during mod load, including before a city is selected.
Use the native train-type selector for construction and the native train
purchase/route controls. Both require their own track type and forbid road
crossings. High-speed sets have eight cars, with one or two sets per train;
maglev allows three through ten cars. Native purchases, inventory, route
assignment and saves retain ownership of all rolling stock.

The [research record](research/high-speed-maglev-trains.md) documents evidence,
currency conversions, every modeling assumption and the rail-physics limitation
of the maglev entry. The repository attribution index is [SOURCES.md](../SOURCES.md).

## Verification

- Platform suite: **749 passed**. Japan consumer suite: **7 passed**.
- Regression coverage checks complete finite definitions, platform margins,
  set increments, dedicated compatibility, native finance inputs, fresh
  registration after registry reset, retained owned inventory, and registration
  before Japan becomes active.
- Built from `prototype/japan/mod` with `node scripts/build-mod.mjs`, reusing
  existing artifacts for all 47 prefectures.
- Verified the bundle marker `open-world-intercity-trains-v1`, both type IDs,
  manifest identity and unchanged world-definition hash before installation.
- The enabled installation discovered by the game's mod scanner is
  `%APPDATA%/metro-maker4/mods/local.japan-open-world`. Installed the freshly
  built `index.js` into this exact folder. The development installer's suffix
  convention would instead create `japan-open-world`, so it was not used.
  The existing release manifest and city packages were retained.
- Built and installed SHA-256:
  `D1A24AD6884B8392DBBDAE1F97172BFC22BAA98897B14CFA98D82A4564ED6608`.
  Both bundle timestamps: `2026-09-10T03:46:45.764861Z`.
- Called the native `SubwayBuilderAPI.reloadMods()`, reset map-move diagnostics,
  and read `__japanDiagnostics__.intercityTrains`: status `registered`, version
  `open-world-intercity-trains-v1`, both IDs present. The live registry contained
  all configured stats. Existing owned-car counts were retained; new types
  initialized to zero owned cars.
- Read-only checks using the running game's native pure helpers returned
  default formations of **8 / 3 cars**, and platform limits of **8–16 / 3–10**
  for high-speed rail / maglev respectively. These helper checks created no
  routes, tracks or purchases in the player's network. A driven service and
  save/reload of purchased new stock were not exercised in this capture.
- PMTiles health: HTTP **200**, `X-PMTiles-Server-Version:
  native-pmtiles-directory-v4`, and `X-OpenWorld-Route-Archive:
  stored-driving-routes-v1`. No city files changed or service restart was needed.
