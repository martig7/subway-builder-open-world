from __future__ import annotations

import gzip
import json
import struct
import tempfile
import unittest
from pathlib import Path

from open_world_map_creator.demand.building_sites import BINARY_MAGIC, HEADER_SIZE
from open_world_map_creator.routing.grid_repair import relocate_marked_grid_points


def _write_gzip(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as destination:
        json.dump(payload, destination)


def _read_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


class GridRepairTests(unittest.TestCase):
    def test_moves_only_marked_points_and_preserves_existing_routes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            demand = root / "demand"
            output = root / "repaired"
            maps = root / "maps"
            catalog = root / "catalog.json"
            boundaries = root / "boundaries.geojson"
            invalidation = root / "invalidation.json"
            catalog.write_text(json.dumps({
                "tiles": [{"id": "A", "prefCode": "01", "bounds": [138.9, 34.9, 139.2, 35.2]}],
            }), encoding="utf-8")
            boundaries.write_text(json.dumps({
                "type": "FeatureCollection",
                "features": [{
                    "type": "Feature",
                    "properties": {"pref_code": "01"},
                    "geometry": {"type": "Polygon", "coordinates": [[
                        [138.9, 34.9], [139.2, 34.9], [139.2, 35.2],
                        [138.9, 35.2], [138.9, 34.9],
                    ]]},
                }],
            }), encoding="utf-8")

            header = bytearray(HEADER_SIZE)
            struct.pack_into("<I", header, 0, BINARY_MAGIC)
            header[4] = 1
            struct.pack_into("<I", header, 8, 2)
            struct.pack_into("<d", header, 40, 0.0009)
            building_bounds = struct.pack(
                "<8d",
                139.0010, 35.0010, 139.0012, 35.0012,
                139.1000, 35.1000, 139.1002, 35.1002,
            )
            building_path = maps / "A" / "buildings_index.bin.gz"
            building_path.parent.mkdir(parents=True)
            with gzip.open(building_path, "wb") as destination:
                destination.write(header)
                destination.write(building_bounds)

            native = {
                "points": [
                    {"id": "safe", "location": [139.1, 35.1], "jobs": 10, "residents": 0, "popIds": ["p"]},
                    {"id": "deferred-source-grid", "location": [139.0, 35.0], "jobs": 0, "residents": 10, "popIds": ["p"]},
                ],
                "pops": [{
                    "id": "p", "size": 10, "residenceId": "deferred-source-grid",
                    "jobId": "safe", "drivingSeconds": 777, "drivingDistance": 888,
                }],
            }
            _write_gzip(demand / "tiles" / "A" / "demand_data.json.gz", native)
            cross = {
                "schemaVersion": 1,
                "tileId": None,
                "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
                "points": [["deferred-source-grid", 139.0, 35.0, "A", 5, 0], ["safe", 139.1, 35.1, "A", 0, 5]],
                "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance"],
                "pops": [["cp", 5, 0, 1, 0, "07:30", "17:30", 999, 1111]],
                "gateways": ["g"],
                "drivingModel": {"provider": "old"},
            }
            _write_gzip(demand / "world" / "cross_demand.json.gz", cross)
            (demand / "world" / "cross_commutes.json").write_text(json.dumps({
                "schemaVersion": 1,
                "buckets": [{"id": "b", "homeTileId": "A", "workTileId": "A", "gatewayId": "g", "mass": 5, "defaultTravelSeconds": 999}],
                "gateways": [{"id": "g"}],
            }), encoding="utf-8")
            _write_gzip(demand / "tiles" / "A" / "cross_demand.json.gz", {**cross, "tileId": "A"})
            (demand / "tiles" / "A" / "cross_commutes.json").write_text("{}", encoding="utf-8")
            (demand / "tiles" / "A" / "manifest.json").write_text(json.dumps({
                "schemaVersion": 1, "tileId": "A", "assets": [], "sha256": "old",
            }), encoding="utf-8")
            invalidation.write_text(json.dumps({
                "native": {"A": {"points": [{"id": "deferred-source-grid", "location": [139.0, 35.0]}], "pops": []}},
                "cross": {"points": [{"id": "deferred-source-grid", "longitude": 139.0, "latitude": 35.0, "tileId": "A"}], "pops": [], "affectedPartitions": [["A", "A"]]},
            }), encoding="utf-8")

            report = relocate_marked_grid_points(
                demand, output, catalog, maps, invalidation,
                maximum_snap_metres=1_000, boundary_path=boundaries,
            )

            repaired_native = _read_gzip(output / "tiles" / "A" / "demand_data.json.gz")
            points = {point["id"]: point for point in repaired_native["points"]}
            self.assertEqual(points["deferred-source-grid"]["location"], [139.0011, 35.0011])
            self.assertEqual(points["safe"]["location"], [139.1, 35.1])
            self.assertEqual(repaired_native["pops"][0]["drivingSeconds"], 777)
            repaired_cross = _read_gzip(output / "world" / "cross_demand.json.gz")
            self.assertEqual(repaired_cross["points"][0][1:3], [139.0011, 35.0011])
            self.assertEqual(repaired_cross["pops"][0][-2:], [999, 1111])
            self.assertEqual(report["uniquePointCount"], 1)
            self.assertEqual(report["skippedPointCount"], 0)
            self.assertEqual(report["duplicateBuildingAssignments"], 0)


if __name__ == "__main__":
    unittest.main()
