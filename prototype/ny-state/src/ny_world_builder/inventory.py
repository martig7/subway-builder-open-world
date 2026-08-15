from __future__ import annotations

import csv
import gzip
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from pyproj import Transformer

from .config import WorldConfig
from .util import atomic_write_text, stable_tile_id, write_json


def _load_catalog(path: str | Path) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if value.get("selection", {}).get("normalCount") != 33:
        raise ValueError("inventory requires the frozen 33-normal-tile catalog")
    return value


def _load_crosswalk(
    config: WorldConfig,
    catalog: dict[str, Any],
    crosswalk_path: str | Path,
) -> tuple[dict[str, str], dict[str, Any]]:
    transformer = Transformer.from_crs("EPSG:4326", config.crs, always_xy=True)
    addressable = {(tile["column"], tile["row"]): tile["id"] for tile in catalog["tiles"]}
    blocks: dict[str, str] = {}
    coordinate_cells: Counter[str] = Counter()
    missing_coordinates = 0
    with gzip.open(crosswalk_path, "rt", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            block_id = row["tabblk2020"]
            try:
                longitude = float(row["blklondd"])
                latitude = float(row["blklatdd"])
            except (TypeError, ValueError):
                blocks[block_id] = "UNRESOLVED_COORDINATE"
                missing_coordinates += 1
                continue
            x, y = transformer.transform(longitude, latitude)
            column, grid_row = config.grid.coordinates(x, y)
            tile_id = addressable.get((column, grid_row))
            if tile_id is None:
                tile_id = f"UNPLANNED_{stable_tile_id(column, grid_row)}"
            blocks[block_id] = tile_id
            coordinate_cells[tile_id] += 1
    report = {
        "blockCount": len(blocks),
        "missingCoordinateCount": missing_coordinates,
        "blocksByCell": dict(sorted(coordinate_cells.items())),
        "unplannedBlockCount": sum(count for tile_id, count in coordinate_cells.items() if tile_id.startswith("UNPLANNED_")),
    }
    return blocks, report


def _new_tile_stats(catalog: dict[str, Any]) -> dict[str, dict[str, int]]:
    return {
        tile["id"]: {
            "homeOdRows": 0,
            "homeWorkers": 0,
            "workOdRows": 0,
            "workWorkers": 0,
            "externalInboundOdRows": 0,
            "externalInboundWorkers": 0,
        }
        for tile in catalog["tiles"]
    }


def _choose_pilots(catalog: dict[str, Any], tile_stats: dict[str, dict[str, int]]) -> list[dict[str, Any]]:
    by_coordinate = {(tile["column"], tile["row"]): tile for tile in catalog["tiles"]}
    pilots: list[dict[str, Any]] = []
    fixed = [
        ((0, 0), "dense-cluster: NYC base"),
        ((0, 1), "dense-cluster: lower Hudson / north of NYC"),
        ((1, 0), "dense-cluster: Long Island / east of NYC"),
        ((-1, 1), "dense-cluster: west-northwest neighbor"),
    ]
    selected_ids: set[str] = set()
    for coordinate, reason in fixed:
        tile = by_coordinate.get(coordinate)
        if not tile or tile["status"] != "normal":
            raise ValueError(f"frozen dense pilot tile {coordinate} is not a normal addressable tile")
        selected_ids.add(tile["id"])
        pilots.append({"tileId": tile["id"], "column": coordinate[0], "row": coordinate[1], "reason": reason})

    candidates: list[tuple[float, dict[str, Any]]] = []
    for tile in catalog["tiles"]:
        if tile["status"] != "normal" or tile["id"] in selected_ids or tile["stateIntersectionKm2"] <= 500:
            continue
        stats = tile_stats[tile["id"]]
        activity = stats["homeWorkers"] + stats["workWorkers"]
        density = activity / tile["stateIntersectionKm2"]
        candidates.append((density, tile))
    if len(candidates) < 2:
        raise ValueError("not enough non-dense candidate tiles for medium/rural pilots")
    candidates.sort(key=lambda item: (item[0], item[1]["id"]))
    medium_density = statistics.median(item[0] for item in candidates)
    medium_density_value, medium_tile = min(candidates, key=lambda item: abs(item[0] - medium_density))
    rural_density_value, rural_tile = candidates[0]
    for tile, density, reason in (
        (medium_tile, medium_density_value, "measured median upstate demand density"),
        (rural_tile, rural_density_value, "measured lowest positive demand density among >500 km² tiles"),
    ):
        selected_ids.add(tile["id"])
        pilots.append({
            "tileId": tile["id"],
            "column": tile["column"],
            "row": tile["row"],
            "activityWorkersPerStateKm2": round(density, 3),
            "reason": reason,
        })
    return pilots


def inventory_lodes(
    config: WorldConfig,
    catalog_path: str | Path,
    crosswalk_path: str | Path,
    main_path: str | Path,
    aux_path: str | Path,
    output_json: str | Path,
    output_markdown: str | Path,
    output_pairs_csv: str | Path,
) -> dict[str, Any]:
    catalog = _load_catalog(catalog_path)
    blocks, crosswalk_report = _load_crosswalk(config, catalog, crosswalk_path)
    tile_stats = _new_tile_stats(catalog)
    pair_stats: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    categories: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    createdates: Counter[str] = Counter()
    aux_home_states: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    def add_category(name: str, workers: int) -> None:
        categories[name][0] += 1
        categories[name][1] += workers

    with gzip.open(main_path, "rt", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            workers = int(row["S000"])
            home_tile = blocks.get(row["h_geocode"], "UNRESOLVED_BLOCK")
            work_tile = blocks.get(row["w_geocode"], "UNRESOLVED_BLOCK")
            createdates[row["createdate"]] += 1
            if home_tile in tile_stats:
                tile_stats[home_tile]["homeOdRows"] += 1
                tile_stats[home_tile]["homeWorkers"] += workers
            if work_tile in tile_stats:
                tile_stats[work_tile]["workOdRows"] += 1
                tile_stats[work_tile]["workWorkers"] += workers
            if home_tile in tile_stats and work_tile in tile_stats:
                pair = pair_stats[(home_tile, work_tile)]
                pair[0] += 1
                pair[1] += workers
                add_category("local" if home_tile == work_tile else "crossTile", workers)
            elif home_tile.startswith("UNPLANNED_") or work_tile.startswith("UNPLANNED_"):
                add_category("unplannedCell", workers)
            else:
                add_category("unresolvedMain", workers)

    with gzip.open(aux_path, "rt", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            workers = int(row["S000"])
            work_tile = blocks.get(row["w_geocode"], "UNRESOLVED_BLOCK")
            home_state = row["h_geocode"][:2]
            createdates[row["createdate"]] += 1
            aux_home_states[home_state][0] += 1
            aux_home_states[home_state][1] += workers
            if work_tile in tile_stats:
                tile_stats[work_tile]["externalInboundOdRows"] += 1
                tile_stats[work_tile]["externalInboundWorkers"] += workers
                add_category("externalInbound", workers)
            elif work_tile.startswith("UNPLANNED_"):
                add_category("unplannedCell", workers)
            else:
                add_category("unresolvedAux", workers)

    total_rows = sum(value[0] for value in categories.values())
    total_workers = sum(value[1] for value in categories.values())
    classified_rows = sum(value[0] for name, value in categories.items() if not name.startswith("unresolved") and name != "unplannedCell")
    classified_workers = sum(value[1] for name, value in categories.items() if not name.startswith("unresolved") and name != "unplannedCell")
    pilots = _choose_pilots(catalog, tile_stats)
    tile_metadata = {tile["id"]: tile for tile in catalog["tiles"]}
    tile_rows = []
    for tile_id, stats in tile_stats.items():
        tile = tile_metadata[tile_id]
        activity = stats["homeWorkers"] + stats["workWorkers"]
        tile_rows.append({
            "tileId": tile_id,
            "column": tile["column"],
            "row": tile["row"],
            "status": tile["status"],
            "stateIntersectionKm2": tile["stateIntersectionKm2"],
            **stats,
            "activityWorkers": activity,
            "activityWorkersPerStateKm2": round(activity / max(tile["stateIntersectionKm2"], 0.000001), 3),
        })
    tile_rows.sort(key=lambda item: (-item["activityWorkers"], item["tileId"]))

    pair_rows = [
        {"homeTileId": home, "workTileId": work, "odRows": values[0], "workers": values[1]}
        for (home, work), values in pair_stats.items()
    ]
    pair_rows.sort(key=lambda item: (item["homeTileId"], item["workTileId"]))
    csv_target = Path(output_pairs_csv)
    csv_target.parent.mkdir(parents=True, exist_ok=True)
    temporary_csv = csv_target.with_suffix(csv_target.suffix + ".tmp")
    with temporary_csv.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["homeTileId", "workTileId", "odRows", "workers"])
        writer.writeheader()
        writer.writerows(pair_rows)
    temporary_csv.replace(csv_target)

    report = {
        "schemaVersion": "1.0.0",
        "worldId": config.world_id,
        "prototype": True,
        "source": {"lodesVersion": config.demand["lodesVersion"], "vintage": config.demand["vintage"], "jobType": config.demand["jobType"]},
        "crosswalk": crosswalk_report,
        "totals": {
            "odRows": total_rows,
            "workers": total_workers,
            "classifiedOdRows": classified_rows,
            "classifiedWorkers": classified_workers,
            "classificationRowDelta": total_rows - classified_rows,
            "classificationWorkerDelta": total_workers - classified_workers,
        },
        "categories": {name: {"odRows": value[0], "workers": value[1]} for name, value in sorted(categories.items())},
        "createdates": dict(sorted(createdates.items())),
        "tilePairCount": len(pair_rows),
        "tiles": tile_rows,
        "auxHomeStates": {
            state: {"odRows": values[0], "workers": values[1]}
            for state, values in sorted(aux_home_states.items(), key=lambda item: (-item[1][1], item[0]))
        },
        "pilotTiles": pilots,
    }
    if total_rows != 7_801_578:
        raise ValueError(f"expected 7,801,578 OD rows, got {total_rows}")
    if crosswalk_report["blockCount"] != 288_819:
        raise ValueError(f"expected 288,819 crosswalk rows, got {crosswalk_report['blockCount']}")
    if report["totals"]["classificationRowDelta"] != 0 or report["totals"]["classificationWorkerDelta"] != 0:
        raise ValueError(f"classification gate failed: {report['totals']}")
    if crosswalk_report["unplannedBlockCount"] != 0:
        raise ValueError(f"grid misses {crosswalk_report['unplannedBlockCount']} crosswalk blocks")

    write_json(output_json, report)
    top_pairs = sorted(pair_rows, key=lambda item: (-item["workers"], item["homeTileId"], item["workTileId"]))[:20]
    lines = [
        "# New York LODES tile inventory",
        "",
        "PROTOTYPE — generated by `ny-world-m0 inventory-lodes`; do not edit by hand.",
        "",
        "## Conservation result",
        "",
        f"- OD rows: **{total_rows:,}**",
        f"- Worker mass (`S000`): **{total_workers:,}**",
        f"- Classified row delta: **{report['totals']['classificationRowDelta']:,}**",
        f"- Classified worker delta: **{report['totals']['classificationWorkerDelta']:,}**",
        f"- Addressable tile pairs with demand: **{len(pair_rows):,}**",
        f"- Crosswalk blocks: **{crosswalk_report['blockCount']:,}**",
        f"- Unplanned crosswalk blocks: **{crosswalk_report['unplannedBlockCount']:,}**",
        "",
        "## Categories",
        "",
        "| Category | OD rows | Workers |",
        "| --- | ---: | ---: |",
    ]
    for name, values in sorted(categories.items()):
        lines.append(f"| `{name}` | {values[0]:,} | {values[1]:,} |")
    lines.extend(["", "## Six pilot tiles", "", "| Tile | Grid | Reason |", "| --- | --- | --- |"])
    for pilot in pilots:
        lines.append(f"| `{pilot['tileId']}` | ({pilot['column']}, {pilot['row']}) | {pilot['reason']} |")
    lines.extend(["", "## Largest tile pairs by worker mass", "", "| Home | Work | OD rows | Workers |", "| --- | --- | ---: | ---: |"])
    for pair in top_pairs:
        lines.append(f"| `{pair['homeTileId']}` | `{pair['workTileId']}` | {pair['odRows']:,} | {pair['workers']:,} |")
    lines.append("")
    atomic_write_text(output_markdown, "\n".join(lines))
    return report
