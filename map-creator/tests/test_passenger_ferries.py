import json
import gzip
import importlib.util
import io
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from open_world_map_creator.routing.ferries import PassengerFerryRouter
from open_world_map_creator.routing.ferry_catalog import duration_seconds, passenger_allowed, extract
from open_world_map_creator.routing.generated_roads import RouteResult
from open_world_map_creator.routing.generated_roads import enrich_generated_road_driving, _gzip_json
from open_world_map_creator.routing.osrm import PersistentRouteCache


class Road:
    input_fingerprint = {"datasetId": "test"}

    def __init__(self, path):
        self.cache = PersistentRouteCache(path)
        self.calls = []

    def route_pairs(self, requests, **options):
        result = {}
        for key, a, b in requests:
            self.calls.append((a, b))
            # Directed access: home -> departure; arrival -> job.
            valid = (a, b) in {((0, 0), (1, 0)), ((3, 0), (4, 0))}
            result[key] = RouteResult(120 if valid else 10, 1000, "osrm" if valid else "osrm-no-route-fallback", 0)
        return result

    def close(self):
        self.cache.close()


class FerryTests(unittest.TestCase):
    def test_ferry_chain_charges_transfer_on_each_road_departure(self):
        class ChainRoad(Road):
            def route_pairs(self, requests, **options):
                valid = {((0, 0), (1, 0)), ((2, 0), (3, 0)), ((4, 0), (5, 0))}
                return {key: RouteResult(120, 1000, "osrm" if (tuple(a), tuple(b)) in valid
                                         else "osrm-no-route-fallback", 0) for key, a, b in requests}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            catalog = root / "catalog.json"
            catalog.write_text(json.dumps({"schemaVersion": 1,
                "ports": [{"node": str(i), "roadLocation": [i, 0], "accessMetres": 0}
                          for i in range(1, 5)],
                "edges": [{"from": "1", "to": "2", "seconds": 300, "metres": 5000},
                          {"from": "3", "to": "4", "seconds": 300, "metres": 5000}]}))
            router = PassengerFerryRouter(ChainRoad(root / "cache.sqlite"), catalog)
            result = router.route((0, 0), (5, 0), progress=lambda _: None)
            self.assertEqual(result.seconds, 3 * 120 + 2 * 300 + 2 * 300)
            router.close()

    @unittest.skipUnless(importlib.util.find_spec("osmium"), "requires ferries extra")
    def test_extracts_passenger_only_sailing_with_connected_pedestrian_terminal_access(self):
        def nearest(url, **kwargs):
            coordinates = url.split("/driving/")[1].split("?")[0]
            return io.BytesIO(json.dumps({"code": "Ok", "waypoints": [{
                "location": [float(v) for v in coordinates.split(",")], "distance": 0
            }]}).encode())

        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "catalog.json"
            with patch("urllib.request.urlopen", side_effect=nearest):
                extract(Path(__file__).parent / "fixtures" / "passenger-ferries.osm",
                        "http://localhost:5000", output, lambda _: None)
            catalog = json.loads(output.read_text())
            self.assertEqual(len(catalog["ports"]), 2)
            self.assertEqual({edge["osmWayId"] for edge in catalog["edges"]}, {10})
            self.assertEqual([edge["seconds"] for edge in catalog["edges"]], [1800, 1800])
            self.assertTrue(all(port["accessMetres"] > 5 for port in catalog["ports"]))

    def test_cross_publication_keeps_exact_ferry_times_instead_of_scaling_transfers(self):
        class Backend:
            input_fingerprint = {"ferry": "test"}

            def driving_model(self):
                return {"provider": "osrm", "graphVersion": "test"}

            def report(self):
                return {}

            def route_pairs(self, requests, **options):
                return {key: RouteResult(1800, 5000, "osrm-passenger-ferry", 0)
                        for key, origin, destination in requests}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            demand = root / "demand"
            (demand / "reports").mkdir(parents=True)
            (demand / "reports" / "test-demand.json").write_text("{}")
            catalog = root / "catalog.json"
            catalog.write_text('{"tiles":[],"crs":"EPSG:3857"}')
            _gzip_json(demand / "world" / "cross_demand.json.gz", {
                "pointFields": ["id", "longitude", "latitude", "tileId"],
                "points": [["a", 0, 0, "A"], ["b", .01, 0, "B"], ["c", .02, 0, "B"]],
                "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "drivingSeconds", "drivingDistance"],
                "pops": [["one", 1, 0, 1, 0, 60, 100], ["two", 1, 0, 2, 0, 60, 100]],
                "gateways": ["gate"],
            })
            (demand / "world" / "cross_commutes.json").write_text(json.dumps({"buckets": [
                {"id": "b", "homeTileId": "A", "workTileId": "B", "gatewayId": "gate", "mass": 2}]}))
            enrich_generated_road_driving(catalog, root, demand, report_namespace="test",
                                         consumer_manifest_id="test", route_backend=Backend(),
                                         cross_samples_per_tile_pair=1, progress=lambda _: None)
            with gzip.open(demand / "world" / "cross_demand.json.gz", "rt") as source:
                pops = json.load(source)["pops"]
            self.assertEqual([pop[5] for pop in pops], [1800, 1800])

    def test_transfer_once_after_sailing_and_reuse_negative_and_positive_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            catalog = path / "ferries.json"
            catalog.write_text(json.dumps({"schemaVersion": 1, "ports": [
                {"node": "a", "roadLocation": [1, 0], "accessMetres": 14},
                {"node": "c", "roadLocation": [3, 0], "accessMetres": 14}],
                "edges": [
                    {"from": "a", "to": "b", "seconds": 600, "metres": 5000},
                    {"from": "b", "to": "c", "seconds": 600, "metres": 5000}]}))
            road = Road(path / "cache.sqlite")
            router = PassengerFerryRouter(road, catalog)
            requests = [("valid", (0, 0), (4, 0)), ("reverse", (4, 0), (0, 0))]
            result = router.route_pairs(requests, progress=lambda _: None)
            # 2 road legs + 2 walking connectors + whole sailing + ONE transfer.
            self.assertEqual(result["valid"].seconds, 240 + 20 + 1200 + 300)
            self.assertEqual(result["valid"].metres, 12028)
            self.assertEqual(result["valid"].source, "osrm-passenger-ferry")
            self.assertEqual(result["reverse"].source, "osrm-no-route-fallback")
            calls = len(road.calls)
            router.route_pairs(requests, progress=lambda _: None)
            self.assertEqual(len(road.calls), calls + 2)  # no repeated ferry/access calculations
            self.assertEqual(router.stats["cacheHits"], 2)
            changed = PassengerFerryRouter(road, catalog, 600)
            rerun = changed.route_pairs(requests[:1], progress=lambda _: None)
            self.assertEqual(rerun["valid"].seconds, result["valid"].seconds + 300)
            stored = [json.loads(r[0]) for r in road.cache.connection.execute("SELECT result_json FROM passenger_ferry_cache")]
            self.assertTrue(any(v and v["segments"][0]["mode"] == "drive" for v in stored))
            router.close()

    def test_successful_osrm_route_does_not_enter_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            catalog = path / "ferries.json"
            catalog.write_text('{"schemaVersion":1,"ports":[],"edges":[]}')
            road = Road(path / "cache.sqlite")
            router = PassengerFerryRouter(road, catalog)
            result = router.route_pairs([(1, (0, 0), (1, 0))], progress=lambda _: None)
            self.assertEqual(result[1].source, "osrm")
            self.assertIsNone(router.graph)
            router.close()

    def test_access_and_duration(self):
        self.assertTrue(passenger_allowed({"motor_vehicle": "no", "foot": "yes"}))
        self.assertFalse(passenger_allowed({"foot": "no"}))
        self.assertFalse(passenger_allowed({"access": "private"}))
        self.assertFalse(passenger_allowed({"cargo": "only"}))
        self.assertEqual(duration_seconds("01:30"), 5400)
        self.assertEqual(duration_seconds("45"), 2700)
        self.assertEqual(duration_seconds("PT1H30M"), 5400)
        self.assertIsNone(duration_seconds("unknown"))
        self.assertIsNone(duration_seconds("0"))


if __name__ == "__main__":
    unittest.main()
