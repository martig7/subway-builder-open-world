import gzip
import json
import tempfile
import unittest
from pathlib import Path

from open_world_map_creator.routing.generated_roads import (
    CROSS_OSRM_PUBLICATION, RouteResult, _gzip_json, enrich_generated_road_driving,
)


class IndividualCrossRoutesTests(unittest.TestCase):
    def test_cross_only_publishes_individual_results_and_preserves_native_bytes(self):
        calls = []

        class Backend:
            input_fingerprint = {"dataset": "test"}

            def driving_model(self):
                return {"provider": "osrm", "graphVersion": "test"}

            def report(self):
                return {}

            def route_pairs(self, requests, **options):
                requests = list(requests)
                calls.extend(requests)
                sources = ["osrm", "osrm", "osrm-passenger-ferry",
                           "osrm-straight-water", "osrm-no-route-fallback"]
                return {key: RouteResult(1000 + key * 137, 5000 + key * 91, sources[key], 0)
                        for key, origin, destination in requests}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            demand = root / "demand"
            (demand / "reports").mkdir(parents=True)
            (demand / "reports" / "test-demand.json").write_text("{}")
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({"tiles": [{"id": "A", "status": "selected"}], "crs": "EPSG:3857"}))
            native = demand / "tiles" / "A" / "demand_data.json.gz"
            _gzip_json(native, {"points": [{"id": "home", "location": [0, 0]},
                                          {"id": "work", "location": [1, 1]}],
                                "pops": [{"id": "native", "residenceId": "home", "jobId": "work",
                                          "size": 3, "drivingSeconds": 456, "drivingDistance": 789}]})
            original_native = native.read_bytes()
            (native.parent / "manifest.json").write_text("{}")
            cross = {"pointFields": ["id", "longitude", "latitude", "tileId"],
                     "points": [["a", 0, 0, "A"]] + [[str(i), .01 * i, 0, "B"] for i in range(1, 6)],
                     "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "drivingSeconds", "drivingDistance"],
                     "pops": [[str(i), i + 1, 0, i + 1, 0, 60, 100] for i in range(5)],
                     "gateways": ["gate"]}
            _gzip_json(demand / "world" / "cross_demand.json.gz", cross)
            (demand / "world" / "cross_commutes.json").write_text(json.dumps({"buckets": [
                {"id": "bucket", "homeTileId": "A", "workTileId": "B", "gatewayId": "gate", "mass": 15}]}))
            report = enrich_generated_road_driving(catalog, root, demand, report_namespace="test",
                consumer_manifest_id="test", route_backend=Backend(), cross_only=True,
                cross_samples_per_tile_pair=1, progress=lambda _: None)
            self.assertEqual(native.read_bytes(), original_native)
            self.assertEqual(len(calls), 5)
            self.assertEqual(report["routes"]["preservedNativeRoutes"], 1)
            self.assertEqual(report["selection"]["nativeCohortCount"], 0)
            self.assertEqual(report["policy"]["crossPublication"], CROSS_OSRM_PUBLICATION)
            with gzip.open(demand / "world" / "cross_demand.json.gz", "rt") as stream:
                result = json.load(stream)
            self.assertEqual(result["points"], cross["points"])
            for i, pop in enumerate(result["pops"]):
                self.assertEqual(pop[:5], cross["pops"][i][:5])
                self.assertEqual(pop[5:], [1000 + i * 137, 5000 + i * 91])
            commutes = json.loads((demand / "world" / "cross_commutes.json").read_text())
            self.assertEqual(commutes["buckets"][0]["defaultTravelSeconds"],
                             round(sum((i + 1) * (1000 + i * 137) for i in range(5)) / 15))


if __name__ == "__main__":
    unittest.main()
