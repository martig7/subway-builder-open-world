from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from kc_world_builder.acquire import Source, acquire_source, verify_source
from kc_world_builder.build_maps import build_halo_assets
from kc_world_builder.compile_demand import class_for_tile, compile_cohorts, projections
from kc_world_builder.config import load_world_config
from kc_world_builder.driving_routes import DrivingRoute, OsrmDrivingRouter
from kc_world_builder.normalize_lodes import build_crosswalk_index, normalize_od_files
from kc_world_builder.package import _cross_demand_view, _native_demand, package_tiles
from kc_world_builder.util import iter_jsonl
from kc_world_builder.validate import validate_conservation


ROOT = Path(__file__).parents[1]
CONFIG = ROOT / "config" / "world.yaml"


class PipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_world_config(CONFIG)
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_exact_configuration_and_seam_ownership(self) -> None:
        west, east = self.config.tiles
        self.assertEqual((west.ownership.max_x - west.ownership.min_x, west.ownership.max_y - west.ownership.min_y), (25000, 25000))
        self.assertEqual(self.config.owner_of(west.ownership.max_x, 4318000), "KCE")
        self.assertEqual(self.config.location_kind(west.ownership.min_x - 1000, 4318000), ("HALO", "KCW"))
        self.assertEqual(self.config.location_kind(west.ownership.min_x - 3000, 4318000), ("OUTSIDE", None))

    def test_acquire_reuses_verified_immutable_file(self) -> None:
        target = self.work / "raw" / "fixture.csv"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"fixture-data")
        source = Source("fixture.csv", "https://example.invalid/never-called", hashlib.sha256(b"fixture-data").hexdigest(), 12, "test", "CC0")
        self.assertEqual(acquire_source(source, target), target)
        verify_source(target, source)
        target.write_bytes(b"tampered")
        with self.assertRaises(ValueError): verify_source(target, source)

        zipped = self.work / "fixture.csv.gz"
        with zipped.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as handle:
                handle.write(b"decompressed")
        content_source = Source("fixture.csv.gz", "https://example.invalid/never-called", hashlib.sha256(b"decompressed").hexdigest(), zipped.stat().st_size, "test", "CC0", "gzip-content")
        verify_source(zipped, content_source)

    def _crosswalk(self) -> tuple[Path, Path]:
        crosswalk = self.work / "crosswalk.csv"
        west, east = self.config.tiles
        with crosswalk.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["tabblk2010", "x", "y"]); writer.writeheader()
            writer.writerows([
                {"tabblk2010": "1", "x": west.ownership.min_x + 100, "y": 4318000},
                {"tabblk2010": "2", "x": east.ownership.min_x + 100, "y": 4318000},
                {"tabblk2010": "3", "x": east.ownership.min_x + 400, "y": 4310000},
                {"tabblk2010": "4", "x": west.ownership.min_x - 5000, "y": 4318000},
                {"tabblk2010": "5", "x": west.ownership.min_x - 1000, "y": 4318000},
            ])
        index = self.work / "crosswalk.sqlite"
        self.assertEqual(build_crosswalk_index([crosswalk], index), 5)
        return crosswalk, index

    def test_crosswalk_accepts_current_lodes8_2020_headers(self) -> None:
        crosswalk = self.work / "current_xwalk.csv"
        crosswalk.write_text(
            "tabblk2020,blklatdd,blklondd,cty,trct\n"
            "290950001001001,39.1000,-94.5800,29095,29095000100\n",
            encoding="utf-8",
        )
        index = self.work / "current.sqlite"

        self.assertEqual(build_crosswalk_index([crosswalk], index, project_wgs84=True), 1)
        database = sqlite3.connect(index)
        try:
            block, x, y, county, tract = database.execute(
                "SELECT block,x,y,county,tract FROM blocks"
            ).fetchone()
        finally:
            database.close()
        self.assertEqual(block, "290950001001001")
        self.assertTrue(360_000 < x < 370_000)
        self.assertTrue(4_325_000 < y < 4_335_000)
        self.assertEqual((county, tract), ("29095", "29095000100"))

    def test_normalize_main_aux_then_compile_conserves_and_projects(self) -> None:
        _, index = self._crosswalk()
        main = self.work / "main_od.csv"; aux = self.work / "aux_od.csv"
        main.write_text("h_geocode,w_geocode,S000\n1,1,7\n1,2,260\n", encoding="utf-8")
        aux.write_text("h_geocode,w_geocode,S000\n3,1,6\n4,2,4\n5,2,3\n", encoding="utf-8")
        od = self.work / "od.jsonl"
        report = normalize_od_files(self.config, index, [("KS", "main", main), ("MO", "aux", aux)], od)
        self.assertEqual(report["input_mass"], 280)
        self.assertEqual(report["normalized_mass"], 273)
        self.assertEqual(report["outside_corridor_mass"], 7)
        rows = list(iter_jsonl(od))
        cohorts, _ = compile_cohorts(self.config, rows)
        self.assertEqual(sum(item.mass for item in cohorts), 273)
        # 260 is split to enforce the game-facing maximum cohort size.
        self.assertEqual(len([item for item in cohorts if item.home_block == "000000000000001" and item.work_block == "000000000000002"]), 2)
        self.assertEqual(validate_conservation(self.config, cohorts, 273)["canonical_mass"], 273)
        west_views = projections(self.config, cohorts, "KCW")
        self.assertIn("LOCAL", {view["classification"] for view in west_views})
        self.assertIn("OUTBOUND", {view["classification"] for view in west_views})
        east_views = projections(self.config, cohorts, "KCE")
        self.assertIn("INBOUND", {view["classification"] for view in east_views})
        cross = next(item for item in cohorts if item.home_tile == "KCW" and item.work_tile == "KCE")
        self.assertEqual(class_for_tile(cross, "KCW"), "OUTBOUND")
        self.assertEqual(class_for_tile(cross, "KCE"), "INBOUND")
        self.assertIsNotNone(cross.gateway_id)

    def test_packages_are_compact_and_repeatable(self) -> None:
        west, east = self.config.tiles
        rows = [
            {"home_block": "1", "work_block": "2", "S000": 10, "home_x": west.ownership.min_x + 1, "home_y": 4318000, "work_x": east.ownership.min_x + 1, "work_y": 4318000},
            {"home_block": "1", "work_block": "5", "S000": 5, "home_x": west.ownership.min_x + 1, "home_y": 4318000, "work_x": west.ownership.min_x + 500, "work_y": 4318500},
        ]
        cohorts, _ = compile_cohorts(self.config, rows)
        first = self.work / "first"; second = self.work / "second"
        package_tiles(self.config, cohorts, first, source_hashes={"fixture": "abc"})
        package_tiles(self.config, cohorts, second, source_hashes={"fixture": "abc"})
        self.assertEqual((first / "KCW" / "demand_data.json.gz").read_bytes(), (second / "KCW" / "demand_data.json.gz").read_bytes())
        self.assertEqual((first / "KCW" / "cross_commutes.json").read_bytes(), (second / "KCW" / "cross_commutes.json").read_bytes())
        self.assertEqual((first / "KCW" / "cross_demand.json.gz").read_bytes(), (second / "KCW" / "cross_demand.json.gz").read_bytes())
        manifest = json.loads((first / "KCW" / "build-manifest.json").read_text())
        self.assertEqual(manifest["counts"]["OUTBOUND"], 10)
        runtime_manifest = json.loads((first / "KCW" / "manifest.json").read_text())
        self.assertEqual(runtime_manifest["schemaVersion"], 1)
        self.assertEqual(runtime_manifest["cityCode"], "KCW")
        self.assertIsInstance(runtime_manifest["assets"], list)
        # The mod's live contract remains small: detailed cohorts/trips are
        # retained only as provenance assets, not eagerly loaded JS data.
        self.assertEqual(runtime_manifest["dataFiles"], {"demandData": "demand_data.json.gz"})
        runtime_data = runtime_manifest["runtimeFiles"]
        self.assertEqual(runtime_data["schemaVersion"], 1)
        asset_metadata = {asset["path"]: asset for asset in runtime_manifest["assets"]}
        for name, path in (("crossCommutes", "cross_commutes.json"), ("crossDemand", "cross_demand.json.gz"), ("gates", "gates.bin")):
            descriptor = runtime_data[name]
            self.assertEqual(descriptor["path"], path)
            self.assertEqual(descriptor["encoding"], "gzip-json" if name == "crossDemand" else "canonical-json")
            self.assertEqual(descriptor["bytes"], asset_metadata[path]["bytes"])
            self.assertEqual(descriptor["sha256"], asset_metadata[path]["sha256"])
        with gzip.open(first / "KCW" / "demand_data.json.gz", "rt") as handle:
            demand = json.load(handle)
            # Local demand remains visible. Cross-tile demand stays in
            # cohorts.json and must not create giant native gateway nodes.
            self.assertEqual([pop["size"] for pop in demand["pops"]], [5])
            self.assertFalse(any(point["id"].startswith("gateway:") for point in demand["points"]))
            self.assertTrue(all(pop["id"].split(":")[0] != cohorts[0].id for pop in demand["pops"]))
        with gzip.open(first / "KCW" / "cohorts.json.gz", "rt") as handle:
            self.assertEqual({row["classification"] for row in json.load(handle)["cohorts"]}, {"LOCAL", "OUTBOUND"})
        summary = json.loads((first / "KCW" / "cross_commutes.json").read_text())
        self.assertEqual(summary["tileId"], "KCW")
        self.assertEqual(len(summary["buckets"]), 1)
        bucket = summary["buckets"][0]
        self.assertEqual((bucket["homeTileId"], bucket["workTileId"], bucket["mass"]), ("KCW", "KCE", 10))
        self.assertEqual(bucket["defaultTravelSeconds"], 1800)
        self.assertEqual(bucket["defaultCapacityPerHour"], 10_000)
        gates = json.loads((first / "KCW" / "gates.bin").read_text())
        self.assertTrue(all(len(gateway["location"]) == 2 for gateway in gates))
        self.assertTrue(all(gateway["capacityPerHour"] == 10_000 for gateway in gates))
        with gzip.open(first / "KCW" / "cross_demand.json.gz", "rt") as handle:
            viewer = json.load(handle)
        self.assertEqual(viewer["tileId"], "KCW")
        self.assertEqual(viewer["gateways"], [bucket["gatewayId"]])
        self.assertEqual(len(viewer["pops"]), 1)
        self.assertEqual(viewer["pops"][0][1], 10)
        self.assertEqual(sum(point[4] for point in viewer["points"]), 10)
        self.assertEqual(sum(point[5] for point in viewer["points"]), 10)

    def test_native_demand_merges_neighboring_cells_to_minimum_fifty_person_cohorts(self) -> None:
        west = self.config.tiles[0]
        rows = [
            {"home_block": "h1", "work_block": "w1", "S000": 20, "home_x": west.ownership.min_x + 100, "home_y": 4318000, "work_x": west.ownership.min_x + 1_100, "work_y": 4318000},
            {"home_block": "h2", "work_block": "w2", "S000": 15, "home_x": west.ownership.min_x + 200, "home_y": 4318100, "work_x": west.ownership.min_x + 1_200, "work_y": 4318100},
            {"home_block": "h3", "work_block": "w3", "S000": 15, "home_x": west.ownership.min_x + 300, "home_y": 4318200, "work_x": west.ownership.min_x + 1_300, "work_y": 4318200},
            {"home_block": "h4", "work_block": "w4", "S000": 60, "home_x": west.ownership.min_x + 10_000, "home_y": 4328000, "work_x": west.ownership.min_x + 11_000, "work_y": 4328000},
        ]
        cohorts, _ = compile_cohorts(self.config, rows)

        demand = _native_demand(self.config, projections(self.config, cohorts, "KCW"))

        self.assertEqual(sum(pop["size"] for pop in demand["pops"]), 110)
        self.assertTrue(all(50 <= pop["size"] <= 200 for pop in demand["pops"]))
        self.assertEqual(sorted(pop["size"] for pop in demand["pops"]), [50, 60])
        self.assertTrue(all(max(point["residents"], point["jobs"]) >= 50 for point in demand["points"]))

    def test_native_demand_uses_shared_voronoi_sites_for_locations_within_one_hundred_metres(self) -> None:
        west = self.config.tiles[0]
        rows = [
            {"home_block": "h1", "work_block": "w1", "S000": 50, "home_x": west.ownership.min_x + 100, "home_y": 4318000, "work_x": west.ownership.min_x + 1_100, "work_y": 4318000},
            {"home_block": "h2", "work_block": "w2", "S000": 50, "home_x": west.ownership.min_x + 150, "home_y": 4318000, "work_x": west.ownership.min_x + 1_150, "work_y": 4318000},
        ]
        cohorts, _ = compile_cohorts(self.config, rows)

        demand = _native_demand(self.config, projections(self.config, cohorts, "KCW"))

        self.assertEqual(len(demand["points"]), 2)
        self.assertEqual([pop["size"] for pop in demand["pops"]], [100])
        self.assertEqual(demand["points"][0]["popIds"], demand["points"][1]["popIds"])
        self.assertEqual(sorted(max(point["residents"], point["jobs"]) for point in demand["points"]), [100, 100])

    def test_cross_demand_uses_the_same_shared_sites_and_minimum_cohort_floor(self) -> None:
        west, east = self.config.tiles
        rows = [
            {"home_block": "wh1", "work_block": "ew1", "S000": 30, "home_x": west.ownership.min_x + 100, "home_y": 4318000, "work_x": east.ownership.min_x + 100, "work_y": 4318000},
            {"home_block": "wh2", "work_block": "ew2", "S000": 30, "home_x": west.ownership.min_x + 150, "home_y": 4318000, "work_x": east.ownership.min_x + 150, "work_y": 4318000},
        ]
        cohorts, _ = compile_cohorts(self.config, rows)

        viewer = _cross_demand_view(self.config, cohorts, "KCW")

        self.assertEqual(len(viewer["points"]), 2)
        self.assertEqual([pop[1] for pop in viewer["pops"]], [60])
        self.assertEqual(sum(point[4] for point in viewer["points"]), 60)
        self.assertEqual(sum(point[5] for point in viewer["points"]), 60)
        fields = {name: index for index, name in enumerate(viewer["popFields"])}
        pop = viewer["pops"][0]
        self.assertGreaterEqual(pop[fields["homeDepartureTime"]], 0)
        self.assertLess(pop[fields["homeDepartureTime"]], 24 * 3600)
        self.assertGreaterEqual(pop[fields["workDepartureTime"]], 0)
        self.assertLess(pop[fields["workDepartureTime"]], 24 * 3600)
        self.assertGreaterEqual(
            abs(pop[fields["workDepartureTime"]] - pop[fields["homeDepartureTime"]]),
            90 * 60,
        )

    def test_map_packaging_persists_build_time_road_routes_for_native_and_cross_demand(self) -> None:
        west, east = self.config.tiles
        rows = [
            {"home_block": "local-home", "work_block": "local-work", "S000": 50, "home_x": west.ownership.min_x + 100, "home_y": 4318000, "work_x": west.ownership.min_x + 1_100, "work_y": 4318000},
            {"home_block": "cross-home", "work_block": "cross-work", "S000": 50, "home_x": west.ownership.min_x + 100, "home_y": 4319000, "work_x": east.ownership.min_x + 1_100, "work_y": 4319000},
        ]
        cohorts, _ = compile_cohorts(self.config, rows)

        class FixedRouter:
            metadata = {"provider": "fake", "profile": "driving", "datasetId": "fixture-roads"}

            def route(self, _origin: tuple[float, float], _destination: tuple[float, float]) -> DrivingRoute:
                return DrivingRoute(duration_seconds=777, distance_metres=12_345)

        router = FixedRouter()
        native = _native_demand(self.config, projections(self.config, cohorts, "KCW"), router)
        cross = _cross_demand_view(self.config, cohorts, "KCW", router)

        self.assertEqual((native["pops"][0]["drivingSeconds"], native["pops"][0]["drivingDistance"]), (777, 12_345))
        self.assertEqual(cross["popFields"][-2:], ["drivingSeconds", "drivingDistance"])
        self.assertEqual(cross["pops"][0][-2:], [777, 12_345])
        self.assertEqual(cross["drivingModel"]["datasetId"], "fixture-roads")

    def test_osrm_router_uses_fastest_route_response_and_reuses_a_versioned_cache(self) -> None:
        calls: list[str] = []

        def opener(url: str, **_kwargs: object) -> io.BytesIO:
            calls.append(url)
            return io.BytesIO(json.dumps({"code": "Ok", "routes": [{"duration": 321.4, "distance": 4_567.8}]}).encode())

        cache = self.work / "driving-routes.json"
        with OsrmDrivingRouter("http://127.0.0.1:5000", dataset_id="kc-osm-fixture", cache_path=cache, opener=opener) as router:
            first = router.route((-94.6, 39.1), (-94.5, 39.2))
            second = router.route((-94.6, 39.1), (-94.5, 39.2))

        self.assertEqual(first, DrivingRoute(321.4, 4_567.8))
        self.assertEqual(second, first)
        self.assertEqual(len(calls), 1)
        with OsrmDrivingRouter("http://127.0.0.1:5000", dataset_id="kc-osm-fixture", cache_path=cache, opener=lambda *_args, **_kwargs: self.fail("cache miss")) as cached:
            self.assertEqual(cached.route((-94.6, 39.1), (-94.5, 39.2)), first)

    def test_zero_length_osrm_route_is_left_for_the_package_minimum_clamp(self) -> None:
        def opener(_url: str, **_kwargs: object) -> io.BytesIO:
            return io.BytesIO(json.dumps({"code": "Ok", "routes": [{"duration": 0, "distance": 0}]}).encode())

        router = OsrmDrivingRouter("http://127.0.0.1:5000", dataset_id="fixture", opener=opener)

        self.assertEqual(router.route((-94.6, 39.1), (-94.6, 39.1)), DrivingRoute(0, 0))

    def test_oversized_shared_site_flow_is_balanced_into_fifty_to_two_hundred_person_cohorts(self) -> None:
        west = self.config.tiles[0]
        rows = [{
            "home_block": "home", "work_block": "work", "S000": 401,
            "home_x": west.ownership.min_x + 100, "home_y": 4318000,
            "work_x": west.ownership.min_x + 1_100, "work_y": 4318000,
        }]
        cohorts, _ = compile_cohorts(self.config, rows)

        demand = _native_demand(self.config, projections(self.config, cohorts, "KCW"))

        self.assertEqual(sorted(pop["size"] for pop in demand["pops"]), [133, 134, 134])
        self.assertEqual(len(demand["points"]), 2)
        self.assertEqual(sorted(max(point["residents"], point["jobs"]) for point in demand["points"]), [401, 401])

    def test_fixture_halo_map_builder(self) -> None:
        west, east = self.config.tiles
        source = self.work / "features.ndjson"
        features = [
            {"type": "Feature", "properties": {"kind": "road"}, "geometry": {"type": "Point", "coordinates": [west.ownership.min_x - 1000, 4318000]}},
            {"type": "Feature", "properties": {"kind": "building"}, "geometry": {"type": "Point", "coordinates": [east.ownership.max_x + 1000, 4318000]}},
            {"type": "Feature", "properties": {"kind": "road"}, "geometry": {"type": "Point", "coordinates": [west.ownership.min_x - 3000, 4318000]}},
        ]
        source.write_text("".join(json.dumps(item) + "\n" for item in features), encoding="utf-8")
        report = build_halo_assets(self.config, source, self.work / "maps")
        self.assertEqual(report["KCW"]["roads"], 1)
        self.assertEqual(report["KCE"]["buildings"], 1)


if __name__ == "__main__":
    unittest.main()
