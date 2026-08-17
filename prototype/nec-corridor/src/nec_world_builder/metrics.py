from __future__ import annotations

import csv
import json
from collections import defaultdict
from pathlib import Path
from typing import Any


def _read_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def build_tile_metrics(inventory: dict[str, Any], catalog: dict[str, Any] | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if inventory.get("scope") != "selected-tile-pairs":
        raise ValueError("tile metrics require an inventory with scope=selected-tile-pairs")

    pair_rows = [dict(pair) for pair in inventory.get("tilePairs", [])]
    inbound: dict[str, dict[str, int]] = defaultdict(lambda: {"rows": 0, "workers": 0})
    outbound: dict[str, dict[str, int]] = defaultdict(lambda: {"rows": 0, "workers": 0})
    for pair in pair_rows:
        home = pair["homeTileId"]
        work = pair["workTileId"]
        if home == work:
            continue
        outbound[home]["rows"] += pair["rows"]
        outbound[home]["workers"] += pair["workers"]
        inbound[work]["rows"] += pair["rows"]
        inbound[work]["workers"] += pair["workers"]

    catalog_by_id = {tile["id"]: tile for tile in (catalog or {}).get("tiles", [])}
    metrics: list[dict[str, Any]] = []
    for tile in inventory["tiles"]:
        tile_id = tile["tileId"]
        metadata = catalog_by_id.get(tile_id, {})
        inbound_stat = inbound[tile_id]
        outbound_stat = outbound[tile_id]
        metrics.append(
            {
                "tileId": tile_id,
                "column": metadata.get("column"),
                "row": metadata.get("row"),
                "ownershipProjected": metadata.get("ownershipProjected"),
                "bounds": metadata.get("bounds"),
                "homeWorkers": tile["homeWorkers"],
                "workWorkers": tile["workWorkers"],
                "localWorkers": tile["localWorkers"],
                "corridorInboundWorkers": inbound_stat["workers"],
                "corridorOutboundWorkers": outbound_stat["workers"],
                "corridorInboundRows": inbound_stat["rows"],
                "corridorOutboundRows": outbound_stat["rows"],
                "activityWorkers": tile["activityWorkers"],
                "pairCount": sum(1 for pair in pair_rows if pair["homeTileId"] == tile_id or pair["workTileId"] == tile_id),
            }
        )

    report = {
        "schemaVersion": "0.1.0",
        "worldId": inventory["worldId"],
        "scope": inventory["scope"],
        "source": inventory["source"],
        "selection": inventory["selection"],
        "totals": {
            "scannedRows": inventory["totals"]["scannedRows"],
            "scannedWorkers": inventory["totals"]["scannedWorkers"],
            "excludedRows": inventory["totals"]["excludedRows"],
            "excludedWorkers": inventory["totals"]["excludedWorkers"],
            "retainedRows": inventory["totals"]["inputRows"],
            "retainedWorkers": inventory["totals"]["inputWorkers"],
            "localWorkers": inventory["categories"]["local"]["workers"],
            "corridorCrossTileWorkers": inventory["categories"]["corridorCrossTile"]["workers"],
            "classificationRowDelta": inventory["totals"]["classificationRowDelta"],
            "classificationWorkerDelta": inventory["totals"]["classificationWorkerDelta"],
        },
        "tiles": metrics,
        "tilePairCount": len(pair_rows),
    }
    return report, pair_rows


def write_tile_metrics(
    inventory_path: str | Path,
    output_path: str | Path,
    pairs_path: str | Path,
    catalog_path: str | Path | None = None,
) -> dict[str, Any]:
    inventory = _read_json(inventory_path)
    catalog = _read_json(catalog_path) if catalog_path else None
    report, pair_rows = build_tile_metrics(inventory, catalog)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")

    pairs = Path(pairs_path)
    pairs.parent.mkdir(parents=True, exist_ok=True)
    with pairs.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["homeTileId", "workTileId", "rows", "workers"])
        writer.writeheader()
        writer.writerows(pair_rows)
    return report
