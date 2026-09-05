# Japan label recovery audit — 2026-09-05

Scope: Japan Open World (`local.japan-open-world`), consumer
`prototype/japan/mod`. Read-only audit of all 47 existing map packages and cached
OSM inputs. No maps, demand, routing, installed files, or services were changed.
The earlier dictionary-conversion draft was replaced by this audit; no guessed
kanji readings were published.

## Results

| Category | Distinct label locations |
| --- | ---: |
| Existing labels, deduplicated across zooms and overlapping packages | 217,879 |
| Excluded numbered block/address/subdivision labels | 91,742 |
| Retained labels | 126,137 |
| Recoverable Latin spelling or kana reading | 72,814 (57.7% of retained) |
| Missing source reading | 53,322 |
| Ambiguous OSM-node match, held for review | 1 |
| Total unresolved | 53,323 (42.3% of retained) |

The unresolved locations represent 41,348 distinct Japanese name strings. Names
at different locations must not share a guessed reading merely because the
kanji match.

Recoverable breakdown: 8,146 explicit romanization fields; 63,649 Latin-script
`name:en` values; 878 explicit kana readings; 134 names already written entirely
in kana; 7 names already in Latin script. English fields may be English display
names rather than strict Japanese romanizations. These are OSM-supplied
candidates, **not independently verified official spellings**.

All 1,559 city-layer locations (cities, boroughs, towns) have source spellings.
Of 541 suburb-layer locations (suburbs/villages), 41 lack readings. The remaining
53,282 unresolved locations are neighborhood-layer labels, including the one
ambiguous match. No retained Japanese label was left unmatched to a source
candidate. Resolved source matches were at most 0.185 m from the rendered point.

See `japan-label-audit.json` for all layer and per-package counts. Per-package
counts include halo labels and therefore must not be summed into a national
total.

## Evidence and method

- Inspected `MapGen.add_labels` in existing Depot image
  `kc-two-tile-depot:ef4ab40` (image ID
  `sha256:d6a637c626703857ce4039a39a18c8db1dbf8b3feb028db21fa27bfe17d84e90`).
  It extracts OSM **place nodes**, then runs Tippecanoe with `-y name`; other
  source name fields are not retained in the resulting label layers.
- Read all eight cached regional Geofabrik Japan extracts, the original
  Tokyo–Kanagawa Kanto extract, and the cached nationwide routing extract.
  No replacement source downloads were needed. Source SHA-256 inventories are
  retained alongside each extracted name file.
- Scanned the highest stored zoom of all 47 PMTiles archives. The three label
  layers persist at that zoom. Deduplicated by layer, original name, and global
  quantized Mercator position, eliminating buffered-tile and package-halo copies.
- Matched normalized original name, compatible OSM `place` class, and location
  within 30 m. Candidates for different OSM IDs within 2 m of the nearest
  candidate are held as ambiguous. All resolved matches were actually within
  0.185 m. Different readings across snapshots would be held as conflicts; none
  occurred in this audit.
- Excluded labels matching explicit numbered address/subdivision patterns:
  `丁目`, `番`/`番地`, `号`, `街区`, `地割`, bare numbers, and English
  `Block N` / `N-chome`. This is a conservative name-pattern filter, not a claim
  that every OSM neighborhood is an address. Named places such as 四日市市,
  八王子市, 一宮市, and 六本木 remain included. Named chome labels are intentionally
  excluded as well as bare block numbers to address close-zoom clutter.
- Accepted explicit Japanese Latin-script keys, then Latin-script English
  names, then all-kana pronunciation fields. Kanji-only, mixed-kanji readings,
  historical names, and unrelated foreign-language names were not guessed or
  automatically substituted.

The ambiguous location is 住吉町 at approximately 130.442187 E, 33.036725 N,
visible in three package halos. It counts once nationally.

## Reproduction and retained evidence

Install the map creator's `label-audit` optional dependencies. The standalone
script `map-creator/scripts/audit_japan_labels.py` has three commands:

```text
extract --source <cached.osm.pbf> [--source <another.osm.pbf>] --output <source-reports>
inventory --maps-root prototype/japan/generated/maps --catalog worlds/japan/geography/tile-views.json --output <inventory.jsonl.gz>
compare --inventory <inventory.jsonl.gz> --sources <source-reports> --output <audit-reports>
```

The source extractor may run on any runner. Transfer its small report directory
to the machine holding map archives; do not transfer the OSM files unnecessarily.
The script never writes to its input map or source paths.

Local evidence for this run:

- `.analysis/japan-labels/sources/source-*.jsonl.gz` and adjacent manifests:
  source place nodes, all original tags, source paths, and SHA-256 checksums.
- `.analysis/japan-labels/inventory.jsonl.gz`: deduplicated rendered labels.
- `.analysis/japan-labels/audit/matches.jsonl.gz`: every label's disposition,
  recovered text/readings, matching OSM node ID, source file, and distance.
- `.analysis/japan-labels/audit/missing-names.json`: unresolved name strings.

Tests cover address exclusions versus genuine numbered place names, rejecting
guessed/mixed-script readings, geographic matching, ambiguous IDs, and source
reading conflicts. The user will decide the next missing-data strategy before
any label replacement or installation. Prefecture selector names are a separate
47-entry catalog and are not part of these map-label counts.
