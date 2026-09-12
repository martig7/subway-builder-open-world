# Japan weekday non-commute movement evidence

This directory contains the reproducible movement ledger used by the Japan
non-commute map. Counts are one-way movements on a representative weekday.
They are not annual trips or unique residents.

`movements.csv` keeps the 2015 national survey at its published 207-life-area
resolution outside the three metropolitan exclusion groups. Its 30 regional
replacement rows use prefecture-level Tokyo, Chukyo, and Kinki Person Trip
survey totals. Regional return-home trips use the single survey-specific
fraction documented in `build-report.json`:

```text
q = B / (B + C)
estimate(i, j) = B(i, j) + q * R(i, j)
```

Here `B` is explicitly business/private travel, `C` is commute/school travel,
and `R` is return-home travel. Unknown-purpose mass is omitted and retained in
the ledger and report. Chukyo and Tokyo coverage limitations remain explicit.

The national XLS has distinct numeric zero cells and empty cells. In
`movements.csv`, `reported_zero` retains an explicit zero, while
`unreported_blank` leaves both movement fields empty; blanks are not evidence
of zero demand and are not drawn on the map. The `－` exclusions are omitted.

`zones.csv` supplies population-weighted representative points for the map.
The build maps the official 2005 207-zone municipality correspondence onto the
repository's existing 2020 e-Stat small-area boundary archives. These points
locate zone-level flows for inspection; they do not claim observed trip
endpoints or exact 2005 zone polygons.

## Build

Install the `map-creator` Japan dependencies, download the seven files listed in
`sources.lock.json` under the same filenames, and place them in the ignored
directory `map-creator/data/sources/japan/noncommute/raw`. Then run:

```powershell
python worlds/japan/data/noncommute/build_movement_table.py
```

The script rewrites `movements.csv`, `zones.csv`, `map-data.json`,
`sources.lock.json`, and `build-report.json`. Source hashes make the build input
set auditable. Original survey downloads remain ignored because they are large
binary inputs.

## Foreign-visitor comparison (not combined)

`foreign-visitor-metro-2024.csv` is a separate 30-pair companion from MLIT's
2024 FF-Data `全国籍全機関` domestic-visit OD sheet. It covers inbound foreign
visitors, not all people who live outside a destination prefecture. The source
is annual, in thousands of visitor legs; the companion also divides by the
366 days of 2024 to show a **calendar-day average**, not a representative
weekday. Repeated prefecture visits may count multiple times. The source can
miss short visits; it does not provide 207-zone endpoints.

The companion is **not added** to `movements.csv`, `map-data.json`, or the
7.82-million weekday control. The main national survey's foreign-visitor
overlap is unresolved, and the resident PT sources are from different years.
Use the comparison to scope a later visitor scenario, not as a direct uplift.

Download the official [2024 nationality OD workbook](https://www.mlit.go.jp/sogoseisaku/soukou/content/2024_Nationality_OD.xlsx)
as `map-creator/data/sources/japan/noncommute/raw/ffdata-2024-nationality-od.xlsx`,
then run `python worlds/japan/data/noncommute/build_foreign_visitor_companion.py`.
The build verifies the source hash and records it, the exact conversion, and
regional totals in `foreign-visitor-metro-2024-report.json`.
