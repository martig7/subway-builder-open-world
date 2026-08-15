from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .util import write_json


def build_runtime_fixtures(
    catalog_path: str | Path,
    output_dir: str | Path,
) -> dict[str, Any]:
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    if catalog.get("selection", {}).get("addressableCount") != 35:
        raise ValueError("runtime fixtures require the frozen 35-record New York catalog")
    target = Path(output_dir)
    package_root = target / "tiles"
    packages: dict[str, Any] = {}

    for tile in catalog["tiles"]:
        selectable = tile["status"] == "normal"
        manifest = {
            "schemaVersion": 1,
            "worldId": catalog["worldId"],
            "tileId": tile["id"],
            "cityCode": tile["gameCityCode"],
            "fixture": True,
            "selectable": selectable,
            "status": tile["status"],
            "viewport": tile["initialViewState"],
            "bounds": tile["bounds"],
            "dataFiles": {},
            "assets": [],
        }
        package = {
            "valid": selectable,
            "manifest": manifest,
            "demand": [],
            "commuteCatalog": {
                "schemaVersion": 1,
                "buildHash": "ny-runtime-fixture-v1",
                "gateways": [],
                "buckets": [],
            },
        }
        packages[tile["id"]] = package
        write_json(package_root / tile["id"] / "manifest.json", manifest)

    normal_ids = [tile["id"] for tile in catalog["tiles"] if tile["status"] == "normal"]
    sliver_ids = [tile["id"] for tile in catalog["tiles"] if tile["status"] == "sliver"]
    fixture = {
        "schemaVersion": "1.0.0",
        "prototype": True,
        "catalog": catalog,
        "normalTileIds": normal_ids,
        "sliverTileIds": sliver_ids,
        "packages": packages,
        "initialWorld": {
            "worldId": "ny-state-runtime-fixture",
            "activeTileId": "NY_CP00_RP00",
            "worldTime": 0,
            "wallet": 1_000_000,
        },
    }
    write_json(target / "runtime-fixtures.json", fixture)
    return {
        "valid": True,
        "packageCount": len(packages),
        "normalPackageCount": len(normal_ids),
        "sliverPackageCount": len(sliver_ids),
        "output": str((target / "runtime-fixtures.json").resolve()),
    }

