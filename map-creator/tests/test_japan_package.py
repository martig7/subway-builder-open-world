from __future__ import annotations

import unittest
import json
from pathlib import Path

from open_world_map_creator.demand.package_japan import Site, WeightedPicker, _compile_native, chunk_mass, proportional_allocations, road_estimate, tile_id


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

    def test_map_source_layout_covers_every_prefecture(self) -> None:
        root = Path(__file__).resolve().parents[2]
        value = json.loads((root / "worlds" / "japan" / "map.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(value["prefectureSources"]), [f"{code:02d}" for code in range(1, 48)])
        configured_sources = set(value["sources"])
        self.assertTrue(all(set(names) <= configured_sources for names in value["prefectureSources"].values()))

        catalog = json.loads((root / "worlds" / "japan" / "geography" / "tile-views.json").read_text(encoding="utf-8"))
        self.assertIn("+proj=lcc", catalog["crs"])


if __name__ == "__main__":
    unittest.main()
