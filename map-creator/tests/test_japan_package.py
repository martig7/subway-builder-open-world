from __future__ import annotations

import unittest
import gzip
import json
import statistics
import struct
import tempfile
from pathlib import Path

import shapely
from shapely.geometry import shape
from shapely.ops import transform
from pyproj import Transformer

from open_world_map_creator.demand.building_sites import BINARY_MAGIC, HEADER_SIZE, build_tile_sites
from open_world_map_creator.demand.package_japan import CrossRecord, Site, WeightedPicker, _compile_native, _deferred_source_sites, _partition_source_cells, _promote_same_owner_cross_records, chunk_mass, proportional_allocations, road_estimate, tile_id


class JapanPackageTests(unittest.TestCase):
    def test_stable_tile_ids_preserve_tokyo_kanagawa_compatibility(self) -> None:
        self.assertEqual(tile_id("01"), "JP_PREF_01")
        self.assertEqual(tile_id("13"), "JP_TOKYO_MAINLAND")
        self.assertEqual(tile_id("14"), "JP_KANAGAWA_MAINLAND")
        self.assertEqual(tile_id("47"), "JP_PREF_47")

    def test_allocations_and_chunks_conserve_mass(self) -> None:
        allocations = proportional_allocations([1, 2, 3], 101)
        self.assertEqual(sum(allocations), 101)
        self.assertEqual(sum(chunk_mass(1001)), 1001)
        self.assertTrue(all(value <= 200 for value in chunk_mass(1001)))

    def test_weighted_picker_and_geometric_route_are_deterministic(self) -> None:
        sites = [Site("a", 139.0, 35.0, 1, 0), Site("b", 140.0, 36.0, 4, 2)]
        picker = WeightedPicker(sites, "home_weight")
        self.assertEqual(picker.pick("fixed"), picker.pick("fixed"))
        self.assertEqual(road_estimate(sites[0], sites[1]), road_estimate(sites[0], sites[1]))
        self.assertGreater(road_estimate(sites[0], sites[1])[0], 60)

    def test_boundary_failed_sites_are_diverted_out_of_native_demand(self) -> None:
        site = Site("outside", 139.0, 35.0, 500, 500, "13", "11", True)
        native, diverted, report = _compile_native("JP_TOKYO_MAINLAND", "13", [site], 500)
        self.assertEqual(native, {"points": [], "pops": []})
        self.assertEqual(sum(record.mass for record in diverted), 500)
        self.assertEqual(report["nativeMass"], 0)
        self.assertEqual(report["divertedMass"], 500)

    def test_cross_records_are_promoted_when_rendered_endpoints_share_an_owner(self) -> None:
        home = Site("home", 139.0, 35.0, 10, 0, "13", "11", True)
        work = Site("work", 139.1, 35.1, 0, 10, "14", "11", True)
        deferred = Site("sea", 140.0, 36.0, 5, 5, "11", "11", True)
        records = [
            CrossRecord("promote", 10, home, work, "13", "14"),
            CrossRecord("deferred", 5, deferred, deferred, "11", "11"),
        ]
        payloads = {"11": {"points": [], "pops": []}}
        reports = {"11": {"nativeMass": 0, "cohortCount": 0, "divertedMass": 5, "divertedCohortCount": 1}}

        remaining, report = _promote_same_owner_cross_records(
            payloads, reports, records, {"sea"}
        )

        self.assertEqual([record.id for record in remaining], ["deferred"])
        self.assertEqual(report, {"reclassifiedCrossMass": 10, "reclassifiedCrossCohortCount": 1})
        self.assertEqual(sum(pop["size"] for pop in payloads["11"]["pops"]), 10)
        self.assertEqual(reports["11"]["nativeMass"], 10)

    def test_source_cells_outside_rendered_land_are_deferred_at_source(self) -> None:
        rendered_land = shape({
            "type": "Polygon",
            "coordinates": [[[139.0, 35.0], [140.0, 35.0], [140.0, 36.0], [139.0, 36.0], [139.0, 35.0]]],
        })
        cells = [
            {"longitude": 139.5, "latitude": 35.5, "commuters": 7},
            {"longitude": 141.25, "latitude": 37.5, "commuters": 11},
        ]

        accepted, deferred = _partition_source_cells(cells, rendered_land)
        sites = _deferred_source_sites(
            {"id": "JP_PREF_46", "prefCode": "46"},
            deferred,
            [{"longitude": 141.25, "latitude": 37.5, "jobs": 13}],
        )

        self.assertEqual(accepted, [cells[0]])
        self.assertEqual(deferred, [cells[1]])
        self.assertEqual([(site.longitude, site.latitude) for site in sites], [(141.25, 37.5)])
        self.assertEqual((sites[0].home_weight, sites[0].job_weight), (11, 13))
        self.assertTrue(sites[0].force_cross)

    def test_map_source_layout_covers_every_prefecture(self) -> None:
        root = Path(__file__).resolve().parents[2]
        value = json.loads((root / "worlds" / "japan" / "map.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(value["prefectureSources"]), [f"{code:02d}" for code in range(1, 48)])
        configured_sources = set(value["sources"])
        self.assertTrue(all(set(names) <= configured_sources for names in value["prefectureSources"].values()))

        catalog = json.loads((root / "worlds" / "japan" / "geography" / "tile-views.json").read_text(encoding="utf-8"))
        self.assertIn("+proj=lcc", catalog["crs"])
        self.assertTrue(all(len(tile["ownershipProjected"]) == 4 for tile in catalog["tiles"]))

    def test_published_prefecture_overlay_is_detailed_and_disjoint(self) -> None:
        root = Path(__file__).resolve().parents[2]
        value = json.loads(
            (root / "worlds" / "japan" / "geography" / "prefectures.geojson").read_text(
                encoding="utf-8"
            )
        )
        geometries = [shape(feature["geometry"]) for feature in value["features"]]
        exterior_vertex_counts = [
            sum(len(part.exterior.coords) for part in shapely.get_parts(geometry))
            for geometry in geometries
        ]

        self.assertEqual(len(geometries), 47)
        self.assertTrue(all(geometry.is_valid for geometry in geometries))
        self.assertGreaterEqual(statistics.median(exterior_vertex_counts), 200)
        self.assertGreaterEqual(sum(exterior_vertex_counts), 10_000)
        self.assertEqual(
            sum(len(part.interiors) for geometry in geometries for part in shapely.get_parts(geometry)),
            0,
        )

        projector = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True).transform
        projected = [transform(projector, geometry) for geometry in geometries]
        self.assertFalse(any(
            part.area < 1_000_000
            for geometry in projected
            for part in shapely.get_parts(geometry)
        ))

        tree = shapely.STRtree(projected)
        intersections = tree.query(projected, predicate="intersects")
        overlap_area = sum(
            projected[left].intersection(projected[right]).area
            for left, right in zip(*intersections, strict=True)
            if left < right
        )
        self.assertLess(overlap_area, 1.0)

        by_code = {
            str(feature["properties"]["pref_code"]): projected[index]
            for index, feature in enumerate(value["features"])
        }
        catalog = json.loads(
            (root / "worlds" / "japan" / "geography" / "tile-views.json").read_text(
                encoding="utf-8"
            )
        )
        code_by_tile = {str(tile["id"]): str(tile["prefCode"]) for tile in catalog["tiles"]}
        checked = set()
        for tile in catalog["tiles"]:
            for neighbor in tile.get("neighbors", []):
                if neighbor.get("direction") != "land":
                    continue
                pair = tuple(sorted((str(tile["prefCode"]), code_by_tile[str(neighbor["tileId"])])))
                if pair in checked:
                    continue
                checked.add(pair)
                self.assertLess(by_code[pair[0]].distance(by_code[pair[1]]), 0.01, pair)
                self.assertGreater(
                    by_code[pair[0]].boundary.intersection(by_code[pair[1]].boundary).length,
                    0.01,
                    pair,
                )

    def test_shared_site_builder_anchors_mesh_mass_to_buildings(self) -> None:
        header = bytearray(HEADER_SIZE)
        struct.pack_into("<I", header, 0, BINARY_MAGIC)
        header[4] = 1
        struct.pack_into("<I", header, 8, 3)
        struct.pack_into("<d", header, 40, 0.0009)
        bounds = struct.pack(
            "<12d",
            139.0000, 35.0000, 139.0002, 35.0002,
            139.0023, 35.0017, 139.0025, 35.0019,
            139.0200, 35.0200, 139.0202, 35.0202,
        )
        home = [{"longitude": 139.001, "latitude": 35.001, "commuters": 100}]
        jobs = [{"longitude": 139.001, "latitude": 35.001, "jobs": 80}]
        boundary = shape({
            "type": "Polygon",
            "coordinates": [[[138.99, 34.99], [139.01, 34.99], [139.01, 35.01], [138.99, 35.01], [138.99, 34.99]]],
        })

        with tempfile.TemporaryDirectory() as directory:
            index_path = Path(directory) / "buildings_index.bin.gz"
            with gzip.open(index_path, "wb") as output:
                output.write(header)
                output.write(bounds)
            sites, report = build_tile_sites(
                "JP_PREF_TEST",
                home,
                jobs,
                index_path,
                [138.99, 34.99, 139.01, 35.01],
                boundary,
            )

        building_centers = {(139.0001, 35.0001), (139.0024, 35.0018)}
        self.assertTrue(sites)
        self.assertTrue(all(tuple(site["location"]) in building_centers for site in sites))
        self.assertEqual(sum(site["commuters"] for site in sites), 100)
        self.assertEqual(sum(site["jobs"] for site in sites), 80)
        self.assertEqual(report["unanchoredSiteCount"], 0)


if __name__ == "__main__":
    unittest.main()
