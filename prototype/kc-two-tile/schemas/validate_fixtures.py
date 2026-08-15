"""Dependency-free structural checks for the prototype fixtures.

This deliberately does not pretend to be a complete JSON Schema validator.
CI should use a Draft 2020-12 validator once dependencies are installed.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"


def load(name: str) -> dict:
    with (FIXTURES / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def validate() -> None:
    catalog = load("tile-catalog.json")
    ledger = load("gateway-ledger.json")
    world = load("world-state.json")

    tile_ids = {tile["tileId"] for tile in catalog["tiles"]}
    assert tile_ids == {"KCW", "KCE"}
    assert world["activeTileId"] in tile_ids
    assert set(world["tiles"]) == tile_ids
    assert world["gatewayLedger"] == ledger

    gateway_ids = {gateway["id"] for gateway in catalog["gateways"]}
    assert gateway_ids == {"KCG_NORTH", "KCG_CENTRAL", "KCG_SOUTH"}

    cohort_ids: set[str] = set()
    for cohort in ledger["cohorts"]:
        assert cohort["cohortId"] not in cohort_ids
        cohort_ids.add(cohort["cohortId"])
        assert cohort["originTileId"] in tile_ids
        assert cohort["destinationTileId"] in tile_ids
        assert cohort["originTileId"] != cohort["destinationTileId"]
        assert cohort["gatewayId"] in gateway_ids
        assert cohort["waiting"] + cohort["inTransit"] + cohort["arrived"] == cohort["workers"]

    west_ring = catalog["tiles"][0]["ownership"]["coordinates"][0]
    east_ring = catalog["tiles"][1]["ownership"]["coordinates"][0]
    assert west_ring[0] == west_ring[-1]
    assert east_ring[0] == east_ring[-1]
    assert west_ring[1][0] == east_ring[0][0] == -94.607


if __name__ == "__main__":
    validate()
    print("prototype fixtures: OK")
