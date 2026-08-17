from __future__ import annotations

import csv
import gzip
import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from pyproj import Transformer

from .selection import Selection


@dataclass(frozen=True)
class Endpoint:
    geocode: str
    state_fips: str
    x: float | None
    y: float | None
    tile_id: str | None
    resolved: bool


class CrosswalkIndex:
    def __init__(self, selection: Selection) -> None:
        self.selection = selection
        self._records: dict[str, tuple[float, float, str | None]] = {}
        self.known_state_fips: set[str] = set()
        self._transformer = Transformer.from_crs("EPSG:4326", selection.grid.crs, always_xy=True)

    def load(self, path: str | Path, state_fips: str | None = None) -> int:
        source = Path(path)
        if state_fips:
            self.known_state_fips.add(str(state_fips).zfill(2))
        loaded = 0
        with gzip.open(source, "rt", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                geocode = str(row["tabblk2020"]).zfill(15)
                state = geocode[:2]
                self.known_state_fips.add(state)
                x, y = self._transformer.transform(float(row["blklondd"]), float(row["blklatdd"]))
                self._records[geocode] = (x, y, self.selection.tile_id_at(x, y))
                loaded += 1
        return loaded

    def resolve(self, geocode: str) -> Endpoint:
        normalized = str(geocode).zfill(15)
        state_fips = normalized[:2]
        record = self._records.get(normalized)
        if record is None:
            return Endpoint(normalized, state_fips, None, None, None, False)
        x, y, tile_id = record
        return Endpoint(normalized, state_fips, x, y, tile_id, True)


def classify_flow(home: Endpoint, work: Endpoint, selected_tile_ids: set[str], known_state_fips: set[str]) -> str:
    if (home.state_fips in known_state_fips and not home.resolved) or (work.state_fips in known_state_fips and not work.resolved):
        return "unresolved"
    if home.tile_id in selected_tile_ids and work.tile_id in selected_tile_ids:
        return "local" if home.tile_id == work.tile_id else "corridorCrossTile"
    if work.tile_id in selected_tile_ids:
        return "externalInbound"
    if home.tile_id in selected_tile_ids:
        return "externalOutbound"
    if home.resolved or work.resolved:
        return "selectedStateOutsideTile"
    return "externalExternal"


def _counter() -> dict[str, int]:
    return {"rows": 0, "workers": 0}


def _add(counter: dict[str, int], workers: int) -> None:
    counter["rows"] += 1
    counter["workers"] += workers


def _tile_stat() -> dict[str, int]:
    return {
        "homeRows": 0,
        "homeWorkers": 0,
        "workRows": 0,
        "workWorkers": 0,
        "localRows": 0,
        "localWorkers": 0,
        "corridorCrossTileRows": 0,
        "corridorCrossTileWorkers": 0,
        "externalInboundRows": 0,
        "externalInboundWorkers": 0,
        "externalOutboundRows": 0,
        "externalOutboundWorkers": 0,
    }


def _iter_rows(path: str | Path) -> Iterable[dict[str, str]]:
    with gzip.open(Path(path), "rt", encoding="utf-8-sig", newline="") as handle:
        yield from csv.DictReader(handle)


def inventory_lodes(
    selection: Selection,
    crosswalk_files: Iterable[tuple[str, str | Path]],
    main_files: Iterable[tuple[str, str | Path]],
    aux_files: Iterable[tuple[str, str | Path]],
    output_path: str | Path | None = None,
    map_only: bool = False,
) -> dict[str, Any]:
    crosswalk = CrosswalkIndex(selection)
    crosswalk_rows: dict[str, int] = {}
    for state_fips, path in crosswalk_files:
        crosswalk_rows[str(state_fips).zfill(2)] = crosswalk.load(path, state_fips)

    selected_tile_ids = set(selection.tile_ids)
    categories: dict[str, dict[str, int]] = defaultdict(_counter)
    partitions: dict[str, dict[str, dict[str, int]]] = {"main": defaultdict(_counter), "aux": defaultdict(_counter)}
    tile_stats = {tile_id: _tile_stat() for tile_id in selection.tile_ids}
    pair_stats: dict[tuple[str, str], dict[str, int]] = defaultdict(_counter)
    source_rows: list[dict[str, Any]] = []
    scanned_rows = 0
    scanned_workers = 0
    input_rows = 0
    input_workers = 0
    excluded_rows = 0
    excluded_workers = 0

    def process(path: str | Path, source_state: str, source_kind: str) -> None:
        nonlocal scanned_rows, scanned_workers, input_rows, input_workers, excluded_rows, excluded_workers
        source_state_fips = str(source_state).zfill(2)
        source_info = {"stateFips": source_state_fips, "kind": source_kind, "path": str(Path(path))}
        source_rows.append(source_info)
        for row in _iter_rows(path):
            try:
                workers = int(row["S000"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"{path}: invalid S000 value in row {row!r}") from error
            home = crosswalk.resolve(row["h_geocode"])
            work = crosswalk.resolve(row["w_geocode"])
            category = classify_flow(home, work, selected_tile_ids, crosswalk.known_state_fips)
            scanned_rows += 1
            scanned_workers += workers
            if map_only and category not in {"local", "corridorCrossTile"}:
                excluded_rows += 1
                excluded_workers += workers
                continue
            input_rows += 1
            input_workers += workers
            _add(categories[category], workers)
            _add(partitions[source_kind][category], workers)

            if home.tile_id in selected_tile_ids:
                stats = tile_stats[home.tile_id]
                stats["homeRows"] += 1
                stats["homeWorkers"] += workers
            if work.tile_id in selected_tile_ids:
                stats = tile_stats[work.tile_id]
                stats["workRows"] += 1
                stats["workWorkers"] += workers
            if home.tile_id in selected_tile_ids and work.tile_id in selected_tile_ids:
                pair = pair_stats[(home.tile_id, work.tile_id)]
                _add(pair, workers)
            for tile_id in {home.tile_id, work.tile_id} & selected_tile_ids:
                stats = tile_stats[tile_id]
                if category == "local":
                    stats["localRows"] += 1
                    stats["localWorkers"] += workers
                elif category == "corridorCrossTile":
                    stats["corridorCrossTileRows"] += 1
                    stats["corridorCrossTileWorkers"] += workers
                elif category == "externalInbound" and work.tile_id == tile_id:
                    stats["externalInboundRows"] += 1
                    stats["externalInboundWorkers"] += workers
                elif category == "externalOutbound" and home.tile_id == tile_id:
                    stats["externalOutboundRows"] += 1
                    stats["externalOutboundWorkers"] += workers

    for state, path in main_files:
        process(path, state, "main")
    for state, path in aux_files:
        process(path, state, "aux")

    classified = {name: value for name, value in categories.items() if name != "unresolved"}
    classified_rows = sum(value["rows"] for value in classified.values())
    classified_workers = sum(value["workers"] for value in classified.values())
    report = {
        "schemaVersion": "0.1.0",
        "worldId": "NEC_CORRIDOR_LODES_PROTOTYPE",
        "scope": "selected-tile-pairs" if map_only else "workplace-state-sources",
        "selection": {"tileCount": len(selection.tiles), "tileIds": list(selection.tile_ids)},
        "source": {"lodesVersion": "LODES8", "vintage": 2023, "jobType": "JT01", "workerColumn": "S000"},
        "crosswalk": {"rowsByStateFips": crosswalk_rows, "knownStateFips": sorted(crosswalk.known_state_fips)},
        "sources": source_rows,
        "totals": {
            "scannedRows": scanned_rows,
            "scannedWorkers": scanned_workers,
            "inputRows": input_rows,
            "inputWorkers": input_workers,
            "excludedRows": excluded_rows,
            "excludedWorkers": excluded_workers,
            "classifiedRows": classified_rows,
            "classifiedWorkers": classified_workers,
            "classificationRowDelta": input_rows - classified_rows,
            "classificationWorkerDelta": input_workers - classified_workers,
        },
        "categories": {name: value for name, value in sorted(categories.items())},
        "partitions": {
            kind: {name: value for name, value in sorted(values.items())}
            for kind, values in partitions.items()
        },
        "tiles": [
            {
                "tileId": tile_id,
                **stats,
                "activityWorkers": stats["homeWorkers"] + stats["workWorkers"],
            }
            for tile_id, stats in sorted(tile_stats.items())
        ],
        "tilePairs": [
            {"homeTileId": home, "workTileId": work, **value}
            for (home, work), value in sorted(pair_stats.items())
        ],
    }
    if output_path:
        target = Path(output_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return report
