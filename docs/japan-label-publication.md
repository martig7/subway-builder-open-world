# Japan source-backed labels with Japanese fallback

Policy: `japan-source-romaji-v1`. Runnable consumer: `local.japan-open-world`,
built and installed from `prototype/japan/mod`.

## Display policy

- Use the audited OSM romanization/Latin-script English value where available.
- Convert only supplied all-kana readings to Hepburn using pinned PyKakasi 2.3.0.
  Do not infer readings from kanji.
- Retain the original Japanese name when source data is missing, ambiguous,
  conflicting, or cannot be matched at the current zoom.
- Exclude numbered block/address/subdivision labels. Inspect both the original
  Japanese name and recovered display value: abbreviated names such as 緑町1
  may be identified as `Midoricho 1-chome` by the source data. Thus publication
  removes a few more addresses than the original Japanese-only audit filter.
- Use the 47 declarative prefecture names in
  `worlds/japan/geography/prefecture-display-names.json` for map selection and
  registration. IDs, boundaries, population, demand locations, and route data
  remain unchanged. The catalog generator reads the same display-name mapping.

All conversion happens before packaging. No dictionary or label-rewriting loop
runs in the game. The map revision changes the tile URL cache key so reloads do
not reuse the previous Japanese-only map tiles.

## Inputs and publication

`worlds/japan/labels.json` pins the source-matches archive by SHA-256:
`e4c55f95a0c281edba45523e27d35c3e2de40f1d83d9f915ede8a43d9718c455`.
It lives at
`map-creator/data/sources/japan/labels/source-matches-20260905.jsonl.gz`.
The original audit copy remains in `.analysis/japan-labels/audit/`.
These generated/data directories are ignored by Git; source regeneration and
audit instructions are recorded in `japan-label-audit.md`.

With `map-creator`'s `label-publication` optional dependencies installed, run:

```powershell
python map-creator/scripts/publish_japan_labels.py `
  --maps-root prototype/japan/generated/maps `
  --catalog worlds/japan/geography/tile-views.json `
  --definition worlds/japan/labels.json `
  --sources-root map-creator/data/sources `
  --backup-root map-creator/data/backups/japan-labels
```

`--tile <ID>` can be repeated for independent batches on any execution machine.
The central Japan artifact script also invokes this stage. The mod builder
rejects raw map manifests without the World's required label policy, before
replacing packaged tiles. Other Worlds without a label policy are unaffected.

The publisher writes staged archives, reads every tile back, and compares a
signature covering exact non-label layer messages plus all surviving label
IDs, geometry, and non-name properties. Low-zoom multipoint/world-wrap geometry
is preserved; conflicting constituent spellings fall back to the original.
It verifies no recognized address labels survive before publishing. Existing
original archives are moved into the backup directory, never discarded.
Matching completed archives are resumable. To process a new source revision,
use a new backup directory; existing originals are never overwritten. Changing
the lookup/policy also requires a new map revision for cache invalidation.

Both `tiles.pmtiles` and `tiles.city-only.pmtiles` are updated. If they were
identical, the second receives the verified first output; otherwise each gets
its own complete transformation and verification. Per-package
`label-publication.json` records counts, input/output hashes, and verified tile
counts. Map manifest asset hashes/sizes are refreshed.

Tests cover source-backed conversion, Japanese fallback, geographic ambiguity,
address aliases, unchanged geometry/content, low-zoom multipoints, the build
gate, and all 47 selector names. Installation still requires the user to reload
the game; verified files on disk are not proof of the renderer's active state.

## Delivered 2026-09-05

All 47 packages completed. Read-back verification covered 2,123,202 tile
records; 1,464,270 label occurrences changed and 1,754,477 numbered-address
occurrences were removed (these counts include repeated zooms/package halos).
The original archives remain in `map-creator/data/backups/japan-labels`.

Platform tests: 487 passed. Japan consumer: 3 passed. Label audit/publication:
6 passed. Catalog/island regression: 1 passed. A structural catalog comparison
confirmed that only the 47 display names changed.

Japan was rebuilt and installed to
`C:/Users/darkd/AppData/Roaming/metro-maker4/mods/japan-open-world`. Built and
installed `index.js` hashes and UTC timestamps match:

- SHA-256: `7a7f8a517e354332f402e9181c596aed20e1a4ab79cf9c0d9e34ae3de0a1e0b2`
- UTC timestamp: `2026-09-05T14:16:58.2042308Z`
- Installed marker: `japan-source-romaji-v1`

All 47 installed PMTiles files and 141 demand/routing files matched their source
hashes. The verified Japan PMTiles process was stopped for copying and restarted
by the installer. Health returned HTTP 200 with
`X-PMTiles-Server-Version: native-pmtiles-directory-v2`. Game reload and visual
confirmation remain with the user. No saves were changed.
