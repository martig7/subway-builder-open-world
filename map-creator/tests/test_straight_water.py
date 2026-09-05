import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shapely.geometry import LineString, box, mapping

from open_world_map_creator.routing.generated_roads import RouteResult, _gzip_json, enrich_generated_road_driving
from open_world_map_creator.routing.osrm import OsrmRouter, PersistentRouteCache
from open_world_map_creator.routing.water import LandMask, StraightWaterRouter


def mask_bytes(*polygons):
    return json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {}, "geometry": mapping(p)} for p in polygons]}).encode()


class Road:
    input_fingerprint = {"datasetId": "test-v1"}

    def __init__(self, cache, land):
        self.cache = PersistentRouteCache(cache)
        self.land = land
        self.nearest_calls = 0

    def driving_model(self):
        return {"provider": "osrm", "graphVersion": "test-v1"}

    def report(self):
        return {}

    def close(self):
        self.cache.close()

    def nearest_candidates(self, coordinate):
        self.nearest_calls += 1
        point = self.land.point(coordinate)
        owner = min(range(len(self.land.parts)), key=lambda i: self.land.parts[i].distance(point))
        # Put the mock road slightly inland, as real OSRM road candidates are.
        line = LineString([point, self.land.parts[owner].representative_point()])
        snapped = line.interpolate(min(10, line.length))
        return [{"location": self.land.coordinate(snapped)}]

    def route_pairs(self, requests, **kwargs):
        routes = {}
        for key, a, b in requests:
            start, end = self.land.point(a), self.land.point(b)
            owner = self.land.owner(start)
            ok = owner is not None and owner == self.land.owner(end)
            routes[key] = RouteResult(600, 2000, "osrm" if ok else "osrm-no-route-fallback", 0)
        return routes


class WaterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.raw = mask_bytes(box(130, 30, 130.02, 30.02), box(130.04, 30, 130.06, 30.02),
                              box(130.08, 30, 130.1, 30.02))
        self.path = self.root / "land.json"
        self.path.write_bytes(self.raw)
        self.land = LandMask(self.raw)
        self.road = Road(self.root / "cache.sqlite", self.land)
        self.addCleanup(self.road.close)
        self.router = StraightWaterRouter(self.road, self.road, self.path)

    def test_two_water_crossings_route_across_intervening_island(self):
        messages = []
        route = self.router.route((130.01, 30.01), (130.09, 30.01), progress=messages.append)
        self.assertEqual(route.source, "osrm-straight-water")
        value = json.loads(self.road.cache.connection.execute("SELECT result_json FROM straight_water_cache").fetchone()[0])
        self.assertEqual([s["mode"] for s in value["segments"]], ["land", "water", "land", "water", "land"])
        for segment in value["segments"]:
            if segment["mode"] == "water":
                self.assertAlmostEqual(segment["seconds"], segment["metres"] * 3.6 / 5)
                ray = LineString([self.land.point(segment["from"]), self.land.point(segment["to"])])
                self.assertLess(sum(p.intersection(ray).length for p in self.land.parts), .01)
        self.assertEqual(route.seconds, max(60, round(sum(s["seconds"] for s in value["segments"]))))
        self.assertEqual(route.metres, round(sum(s["metres"] for s in value["segments"])))
        self.assertTrue(any("[straight-water]" in m for m in messages))

    def test_successful_roads_and_ferries_are_unchanged_and_mask_is_lazy(self):
        for source in ("osrm", "osrm-passenger-ferry", "geometric-long-distance"):
            with self.subTest(source=source), patch.object(self.road, "route_pairs", return_value={0: RouteResult(123, 456, source, 0)}):
                route = self.router.route((130.01, 30.01), (130.09, 30.01))
                self.assertEqual(route, RouteResult(123, 456, source, 0))
                self.assertIsNone(self.router.land)

    def test_same_landmass_failure_is_not_treated_as_water(self):
        failed = RouteResult(123, 456, "osrm-no-route-fallback", 0)
        with patch.object(self.road, "route_pairs", return_value={0: failed}):
            self.assertEqual(self.router.route((130.001, 30.01), (130.019, 30.01), progress=lambda _: None), failed)
        self.assertEqual(self.router.stats["same-landmass"], 1)

    def test_positive_negative_cache_and_coordinate_invalidation(self):
        requests = [(1, (130.01, 30.01), (130.09, 30.01)), (2, (129, 30), (130.09, 30.01))]
        first = self.router.route_pairs(requests, progress=lambda _: None)
        calls = self.road.nearest_calls
        second = self.router.route_pairs(requests, progress=lambda _: None)
        self.assertEqual(first, second)
        self.assertEqual(self.router.stats["cacheHits"], 2)
        self.assertEqual(self.road.nearest_calls, calls)
        self.router.route((130.011, 30.01), (130.09, 30.01), progress=lambda _: None)
        self.assertEqual(self.router.stats["computedPairs"], 3)
        changed = StraightWaterRouter(self.road, self.road, self.path, 500)
        changed.route(*requests[0][1:], progress=lambda _: None)
        self.assertEqual(changed.stats["cacheHits"], 0)
        self.path.write_bytes(mask_bytes(box(130, 30, 130.1, 30.02)))
        self.assertNotEqual(self.router.input_fingerprint,
                            StraightWaterRouter(self.road, self.road, self.path).input_fingerprint)

    def test_rejects_nearest_road_across_water_and_preserves_failure(self):
        with patch.object(self.road, "nearest_candidates", return_value=[{"location": (130.09, 30.01)}]):
            route = self.router.route((130.01, 30.01), (130.09, 30.01), progress=lambda _: None)
        self.assertEqual(route.source, "osrm-no-route-fallback")
        self.assertEqual(self.router.stats["no-reachable-land-road"], 1)

    def test_server_failure_is_not_persisted_as_no_route(self):
        with patch.object(self.road, "nearest_candidates", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                self.router.route((130.01, 30.01), (130.09, 30.01), progress=lambda _: None)
        self.assertEqual(self.road.cache.connection.execute("SELECT count(*) FROM straight_water_cache").fetchone()[0], 0)

    def test_reaims_after_island_instead_of_using_original_ray(self):
        raw = mask_bytes(box(130, 30, 130.02, 30.02), box(130.04, 30, 130.06, 30.08),
                         box(130.08, 30, 130.1, 30.08))
        land = LandMask(raw)
        plan, reason = land.plan((130.01, 30.01), (130.09, 30.07))
        self.assertIsNone(reason)
        middle = plan[2]
        self.assertEqual(middle[0], "land")
        self.assertGreater(land.coordinate(middle[2])[1], land.coordinate(middle[1])[1])
        self.assertAlmostEqual(middle[2].distance(land.point((130.09, 30.07))),
                               land.parts[middle[3]].distance(land.point((130.09, 30.07))), places=5)

    def test_inland_water_holes_and_small_islands_are_not_filled_or_removed(self):
        mainland = box(130, 30, 130.1, 30.1).difference(box(130.02, 30.02, 130.08, 30.08))
        island = box(130.049, 30.049, 130.051, 30.051)
        land = LandMask(mask_bytes(mainland, island))
        self.assertEqual(len(land.parts), 2)
        self.assertIsNone(land.owner(land.point((130.03, 30.03))))
        plan, reason = land.plan((130.05, 30.05), (130.09, 30.05))
        self.assertIsNone(reason)
        self.assertEqual([s[0] for s in plan], ["land", "water", "land"])

    def test_rejects_invalid_masks_and_policy(self):
        with self.assertRaises(ValueError):
            LandMask(mask_bytes())
        with self.assertRaises(ValueError):
            StraightWaterRouter(self.road, self.road, self.path, float("nan"))
        data = json.loads(self.raw)
        data["features"][0]["properties"]["inland_water_policy"] = "filled"
        with self.assertRaisesRegex(ValueError, "Display boundaries"):
            LandMask(json.dumps(data).encode())

    def test_cross_publication_finds_unsampled_water_without_scaling_or_changing_other_routes(self):
        class Backend:
            input_fingerprint = {"water": "test"}
            requires_exact_cross_routes = True

            def driving_model(self):
                return {"provider": "osrm", "graphVersion": "water-test"}

            def report(self):
                return {}

            def route_pairs(self, requests, **options):
                return {key: RouteResult(1800, 5000, "osrm", 0) if b[0] < .02 else
                        RouteResult(9876, 6500, "osrm-straight-water", 0) for key, a, b in requests}

        demand = self.root / "demand"
        (demand / "reports").mkdir(parents=True)
        (demand / "reports" / "test-demand.json").write_text("{}")
        catalog = self.root / "catalog.json"
        catalog.write_text('{"tiles":[],"crs":"EPSG:3857"}')
        _gzip_json(demand / "world" / "cross_demand.json.gz", {
            "pointFields": ["id", "longitude", "latitude", "tileId"],
            "points": [["a", 0, 0, "A"], ["b", .01, 0, "B"], ["c", .02, 0, "B"]],
            "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "drivingSeconds", "drivingDistance"],
            "pops": [["road", 1, 0, 1, 0, 60, 100], ["water", 1, 0, 2, 0, 60, 100]],
            "gateways": ["gate"]})
        (demand / "world" / "cross_commutes.json").write_text(json.dumps({"buckets": [
            {"id": "b", "homeTileId": "A", "workTileId": "B", "gatewayId": "gate", "mass": 2}]}))
        enrich_generated_road_driving(catalog, self.root, demand, report_namespace="test",
                                     consumer_manifest_id="test", route_backend=Backend(),
                                     cross_samples_per_tile_pair=1, progress=lambda _: None)
        with gzip.open(demand / "world" / "cross_demand.json.gz", "rt") as source:
            pops = json.load(source)["pops"]
        self.assertEqual(pops[0][5:], [1800, 5000])
        self.assertEqual(pops[1][5:], [9876, 6500])

    def test_osrm_nearest_is_durable_and_scoped_to_dataset_and_coordinate(self):
        import io
        road = OsrmRouter(base_url="http://test", profile="driving", dataset_id="d1",
                          cache_path=self.root / "nearest.sqlite", retries=0)
        self.addCleanup(road.close)
        def response(*args, **kwargs):
            return io.BytesIO(b'{"code":"Ok","waypoints":[{"location":[130.01,30.01]}]}')
        with patch("urllib.request.urlopen", side_effect=response) as request:
            a = road.nearest_candidates((130.01, 30.01))
            self.assertEqual(a, road.nearest_candidates((130.01, 30.01)))
            self.assertEqual(request.call_count, 1)
            road.nearest_candidates((130.011, 30.01))
            road.dataset_id = "d2"
            road.nearest_candidates((130.01, 30.01))
            self.assertEqual(request.call_count, 3)


if __name__ == "__main__":
    unittest.main()
