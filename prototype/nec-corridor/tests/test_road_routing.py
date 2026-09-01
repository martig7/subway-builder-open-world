from __future__ import annotations

import gzip
import json
import tempfile
import unittest
from pathlib import Path

from nec_world_builder.road_routing import enrich_nec_driving


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def write_gzip_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as output:
        json.dump(value, output)


def read_gzip_json(path: Path) -> object:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


class GeneratedRoadRoutingTests(unittest.TestCase):
    def test_splices_fastest_class_weighted_path_into_existing_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tile_id = "NEC_TEST"
            catalog = root / "catalog.json"
            maps = root / "maps"
            demand = root / "demand"
            write_json(catalog, {
                "crs": "EPSG:3857",
                "tiles": [{
                    "id": tile_id,
                    "status": "selected",
                    "ownershipProjected": [-100, -300, 2_000, 500],
                }],
            })
            roads = {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"roadClass": "minor", "structure": "normal"},
                        "geometry": {"type": "LineString", "coordinates": [[0, 0], [0.01, 0]]},
                    },
                    {
                        "type": "Feature",
                        "properties": {"roadClass": "highway", "structure": "normal"},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[0, 0], [0, 0.002], [0.01, 0.002], [0.01, 0]],
                        },
                    },
                ],
            }
            write_gzip_json(maps / tile_id / "roads.geojson.gz", roads)
            native = {
                "points": [
                    {"id": "home", "location": [0, 0]},
                    {"id": "work", "location": [0.01, 0]},
                ],
                "pops": [{
                    "id": "native-pop", "size": 10, "residenceId": "home", "jobId": "work",
                    "drivingSeconds": 999, "drivingDistance": 999,
                }],
            }
            cross = {
                "schemaVersion": 1,
                "tileId": None,
                "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
                "popFields": [
                    "id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime",
                    "workDepartureTime", "drivingSeconds", "drivingDistance",
                ],
                "drivingModel": {"provider": "geometric"},
                "gateways": ["G"],
                "points": [["home", 0, 0, tile_id, 10, 0], ["work", 0.01, 0, tile_id, 0, 10]],
                "pops": [["cross-pop", 10, 0, 1, 0, 28_800, 61_200, 999, 999]],
            }
            commutes = {
                "schemaVersion": 1,
                "buildHash": "old",
                "buckets": [{
                    "id": "bucket", "homeTileId": tile_id, "workTileId": tile_id, "gatewayId": "G",
                    "mass": 10, "defaultTravelSeconds": 999, "defaultCapacityPerHour": 100,
                }],
                "gateways": [{"id": "G", "location": [0.005, 0]}],
            }
            write_gzip_json(demand / "tiles" / tile_id / "demand_data.json.gz", native)
            write_gzip_json(demand / "tiles" / tile_id / "cross_demand.json.gz", {**cross, "tileId": tile_id})
            write_json(demand / "tiles" / tile_id / "cross_commutes.json", {**commutes, "tileId": tile_id})
            write_json(demand / "tiles" / tile_id / "manifest.json", {
                "schemaVersion": 1,
                "tileId": tile_id,
                "assets": [
                    {"path": "demand_data.json.gz", "bytes": 1, "sha256": "old"},
                    {"path": "cross_commutes.json", "bytes": 1, "sha256": "old"},
                    {"path": "cross_demand.json.gz", "bytes": 1, "sha256": "old"},
                ],
            })
            write_gzip_json(demand / "world" / "cross_demand.json.gz", cross)
            write_json(demand / "world" / "cross_commutes.json", commutes)
            write_json(demand / "reports" / "nec-demand.json", {"aggregation": {"drivingModel": "old"}})

            report = enrich_nec_driving(catalog, maps, demand, progress=lambda _message: None)

            enriched_native = read_gzip_json(demand / "tiles" / tile_id / "demand_data.json.gz")
            native_pop = enriched_native["pops"][0]
            self.assertGreaterEqual(native_pop["drivingSeconds"], 60)
            self.assertLess(native_pop["drivingSeconds"], 90)
            self.assertGreater(native_pop["drivingDistance"], 1_400)
            enriched_cross = read_gzip_json(demand / "world" / "cross_demand.json.gz")
            self.assertEqual(enriched_cross["drivingModel"]["speedKph"], {"highway": 85.0, "major": 50.0, "minor": 30.0})
            self.assertEqual(enriched_cross["pops"][0][-2], native_pop["drivingSeconds"])
            enriched_commutes = json.loads((demand / "world" / "cross_commutes.json").read_text(encoding="utf-8"))
            self.assertEqual(enriched_commutes["buckets"][0]["defaultTravelSeconds"], native_pop["drivingSeconds"])
            self.assertTrue(enriched_commutes["buildHash"].startswith("nec-road-v1-"))
            manifest = json.loads((demand / "tiles" / tile_id / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(all(asset["bytes"] > 1 and asset["sha256"] != "old" for asset in manifest["assets"]))
            self.assertEqual(report["routes"]["generated-road-graph"], 1)
            self.assertEqual(report["routes"]["generated-road-tile-pair-model"], 1)
            self.assertEqual(report["crossSearches"]["searches"], 1)
            self.assertFalse((root / ".demand-road-routing-stage").exists())

    def test_long_distance_policy_preserves_geometric_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tile_id = "NEC_TEST"
            catalog = root / "catalog.json"
            maps = root / "maps"
            demand = root / "demand"
            write_json(catalog, {"crs": "EPSG:3857", "tiles": [{
                "id": tile_id, "status": "selected", "ownershipProjected": [-100, -100, 2_000, 100],
            }]})
            write_gzip_json(maps / tile_id / "roads.geojson.gz", {
                "type": "FeatureCollection",
                "features": [{
                    "type": "Feature", "properties": {"roadClass": "highway"},
                    "geometry": {"type": "LineString", "coordinates": [[0, 0], [0.01, 0]]},
                }],
            })
            native = {
                "points": [{"id": "a", "location": [0, 0]}, {"id": "b", "location": [0.01, 0]}],
                "pops": [{"id": "p", "size": 1, "residenceId": "a", "jobId": "b", "drivingSeconds": 1, "drivingDistance": 1}],
            }
            cross = {
                "schemaVersion": 1, "tileId": None,
                "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
                "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "drivingSeconds", "drivingDistance"],
                "gateways": ["G"], "points": [["a", 0, 0, tile_id, 1, 0], ["b", 0.01, 0, tile_id, 0, 1]],
                "pops": [["p", 1, 0, 1, 0, 1, 1]], "drivingModel": {},
            }
            commutes = {"buckets": [{"id": "b", "homeTileId": tile_id, "workTileId": tile_id, "gatewayId": "G", "mass": 1}], "gateways": []}
            write_gzip_json(demand / "tiles" / tile_id / "demand_data.json.gz", native)
            write_gzip_json(demand / "world" / "cross_demand.json.gz", cross)
            write_json(demand / "world" / "cross_commutes.json", commutes)
            write_json(demand / "tiles" / tile_id / "manifest.json", {"assets": []})
            write_json(demand / "reports" / "nec-demand.json", {"aggregation": {}})

            report = enrich_nec_driving(
                catalog, maps, demand, max_routed_direct_metres=100, progress=lambda _message: None
            )

            self.assertEqual(report["routes"]["geometric-long-distance"], 2)
            enriched = read_gzip_json(demand / "tiles" / tile_id / "demand_data.json.gz")
            self.assertGreater(enriched["pops"][0]["drivingSeconds"], 60)


if __name__ == "__main__":
    unittest.main()
