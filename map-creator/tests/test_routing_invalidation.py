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
from open_world_map_creator.routing.generated_roads import _selective_routing_plan


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

    def test_selective_plan_validates_cohort_identity_after_point_relocation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            demand = root / "demand"
            _write_gzip(demand / "tiles" / "A" / "demand_data.json.gz", {
                "points": [
                    {"id": "building-a", "location": [1.0, 2.0]},
                    {"id": "deferred-source-grid", "location": [3.1, 4.1]},
                ],
                "pops": [{
                    "id": "reroute", "size": 20,
                    "residenceId": "deferred-source-grid", "jobId": "building-a",
                }],
            })
            _write_gzip(demand / "world" / "cross_demand.json.gz", {
                "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
                "points": [
                    ["building-a", 1.0, 2.0, "A", 10, 0],
                    ["deferred-source-grid", 3.1, 4.1, "B", 0, 20],
                ],
                "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance"],
                "pops": [["reroute-cross", 20, 0, 1, 0, "07:30", "17:30", 60, 100]],
            })
            invalidation = root / "invalidation.json"
            invalidation.write_text(json.dumps({
                "native": {"A": {"pops": [{
                    "id": "reroute", "size": 20,
                    "residenceId": "deferred-source-grid", "jobId": "building-a",
                }]}},
                "cross": {
                    "affectedPartitions": [["A", "B"]],
                    "pops": [{
                        "id": "reroute-cross", "mass": 20,
                        "homePointId": "building-a", "workPointId": "deferred-source-grid",
                        "partition": ["A", "B"],
                    }],
                },
            }), encoding="utf-8")

            plan = _selective_routing_plan(demand, invalidation)

            self.assertEqual(plan["nativePopIds"], {"A": {"reroute"}})
            self.assertEqual(plan["crossPartitions"], {("A", "B")})

            payload = _read_gzip_for_test(demand / "world" / "cross_demand.json.gz")
            payload["pops"][0][1] = 21
            _write_gzip(demand / "world" / "cross_demand.json.gz", payload)
            with self.assertRaisesRegex(ValueError, "Invalidated cross cohort changed"):
                _selective_routing_plan(demand, invalidation)


def _read_gzip_for_test(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


if __name__ == "__main__":
    unittest.main()
