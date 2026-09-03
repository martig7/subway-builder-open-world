from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from pathlib import Path

from open_world_map_creator.routing.invalidation import (
    build_grid_routing_invalidation,
    write_grid_routing_invalidation,
)


def _write_gzip(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as destination:
        json.dump(payload, destination)


class RoutingInvalidationTests(unittest.TestCase):
    def test_marks_only_routes_touching_gridded_points(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            demand = Path(temporary) / "demand"
            _write_gzip(demand / "tiles" / "A" / "demand_data.json.gz", {
                "points": [
                    {"id": "building-a", "location": [1.0, 2.0]},
                    {"id": "deferred-source-grid", "location": [3.0, 4.0]},
                ],
                "pops": [
                    {"id": "safe", "size": 10, "residenceId": "building-a", "jobId": "building-a"},
                    {"id": "reroute", "size": 20, "residenceId": "deferred-source-grid", "jobId": "building-a"},
                ],
            })
            _write_gzip(demand / "world" / "cross_demand.json.gz", {
                "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
                "points": [
                    ["building-a", 1.0, 2.0, "A", 10, 0],
                    ["deferred-source-grid", 3.0, 4.0, "B", 0, 20],
                ],
                "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance"],
                "pops": [
                    ["safe-cross", 5, 0, 0, 0, "07:30", "17:30", 60, 100],
                    ["reroute-cross", 20, 0, 1, 0, "07:30", "17:30", 60, 100],
                ],
            })

            manifest = build_grid_routing_invalidation(demand)

            self.assertEqual(manifest["summary"], {
                "uniquePointCount": 1,
                "nativeTileCount": 1,
                "nativePointCount": 1,
                "nativePopCount": 1,
                "crossPointCount": 1,
                "crossPopCount": 1,
                "crossPartitionCount": 1,
            })
            self.assertEqual([pop["id"] for pop in manifest["native"]["A"]["pops"]], ["reroute"])
            self.assertEqual([pop["id"] for pop in manifest["cross"]["pops"]], ["reroute-cross"])
            self.assertEqual(manifest["cross"]["affectedPartitions"], [["A", "B"]])

    def test_refuses_to_place_sidecar_inside_live_demand(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            demand = Path(temporary) / "demand"
            demand.mkdir()
            with self.assertRaisesRegex(ValueError, "outside the live demand directory"):
                write_grid_routing_invalidation(demand, demand / "routing-invalidations.json")


if __name__ == "__main__":
    unittest.main()
