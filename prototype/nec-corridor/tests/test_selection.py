from __future__ import annotations

import json
import unittest
from pathlib import Path
from pyproj import Transformer

from nec_world_builder.catalog import build_catalog
from nec_world_builder.selection import load_selection, validate_selection


ROOT = Path(__file__).resolve().parents[1]
SELECTION_PATH = ROOT / "input" / "nec-corridor-selection.json"


class SelectionTests(unittest.TestCase):
    def test_brigantine_is_selected(self) -> None:
        selection = load_selection(SELECTION_PATH)
        project = Transformer.from_crs("EPSG:4326", selection.grid.crs, always_xy=True)
        # Brigantine City and its northern end both lie in the new coastal tile.
        for longitude, latitude in [(-74.3646, 39.4101), (-74.3722, 39.4701)]:
            self.assertEqual(selection.tile_id_at(*project.transform(longitude, latitude)), "NEC_CP00_RM02")
        catalog, _ = build_catalog(selection)
        tiles = {tile["id"]: tile for tile in catalog["tiles"]}
        brigantine = tiles["NEC_CP00_RM02"]
        self.assertEqual({item["tileId"] for item in brigantine["neighbors"]},
                         {"NEC_CM01_RM02", "NEC_CP00_RM01"})
        for neighbor in brigantine["neighbors"]:
            self.assertIn("NEC_CP00_RM02", {item["tileId"] for item in tiles[neighbor["tileId"]]["neighbors"]})

    def test_block_island_missing_eastern_portion_is_selected(self) -> None:
        selection = load_selection(SELECTION_PATH)
        project = Transformer.from_crs("EPSG:4326", selection.grid.crs, always_xy=True)
        # Old Harbor and Southeast Light lie east of the existing column-2 tile.
        for longitude, latitude in [(-71.557, 41.173), (-71.552, 41.153)]:
            self.assertEqual(selection.tile_id_at(*project.transform(longitude, latitude)), "NEC_CP03_RP00")
        catalog, _ = build_catalog(selection)
        tiles = {tile["id"]: tile for tile in catalog["tiles"]}
        island = tiles["NEC_CP03_RP00"]
        self.assertEqual({item["tileId"] for item in island["neighbors"]},
                         {"NEC_CP02_RP00", "NEC_CP04_RP00", "NEC_CP03_RP01"})
        for neighbor in island["neighbors"]:
            self.assertIn("NEC_CP03_RP00", {item["tileId"] for item in tiles[neighbor["tileId"]]["neighbors"]})

    def test_attached_selection_is_frozen_to_the_new_york_grid(self) -> None:
        selection = load_selection(SELECTION_PATH)
        self.assertEqual(len(selection.tiles), 59)
        self.assertEqual(selection.grid.crs, "EPSG:26918")
        self.assertEqual(selection.grid.bounds(0, 0), (553400, 4483300, 631100, 4580600))
        self.assertEqual(selection.tile_id_at(553401, 4483301), "NEC_CP00_RP00")
        self.assertEqual(selection.tile_id_at(631100, 4483301), "NEC_CP01_RP00")
        self.assertEqual(selection.tile_id_at(631101, 4775201), "NEC_CP01_RP03")

    def test_catalog_has_selected_neighbors_and_geographic_bounds(self) -> None:
        selection = load_selection(SELECTION_PATH)
        catalog, coverage = build_catalog(selection)
        self.assertEqual(catalog["selection"]["selectedCount"], 59)
        self.assertEqual(len(catalog["tiles"]), 59)
        self.assertEqual(len(coverage["features"]), 59)
        center = next(tile for tile in catalog["tiles"] if tile["id"] == "NEC_CP00_RP00")
        self.assertEqual(center["neighbors"], [
            {"direction": "north", "tileId": "NEC_CP00_RP01"},
            {"direction": "east", "tileId": "NEC_CP01_RP00"},
            {"direction": "south", "tileId": "NEC_CP00_RM01"},
            {"direction": "west", "tileId": "NEC_CM01_RP00"},
        ])
        self.assertLess(center["bounds"][0], -73)
        self.assertGreater(center["bounds"][2], -74)
        west = next(tile for tile in catalog["tiles"] if tile["id"] == "NEC_CM01_RP00")
        self.assertEqual(len(center["boundary"]), 5)
        self.assertEqual(center["boundary"][0], center["boundary"][-1])
        self.assertEqual(
            len({tuple(point) for point in center["boundary"][:-1]}
                & {tuple(point) for point in west["boundary"][:-1]}),
            2,
        )

    def test_expansion_matches_populated_adjacent_cells(self) -> None:
        selection = load_selection(SELECTION_PATH)
        evidence = json.loads((ROOT.parents[1] / "worlds/nec-corridor/geography/expansion-evidence.json").read_text(encoding="utf-8"))
        cells = selection.coordinates
        for candidate in evidence["candidateCells"]:
            coordinate = candidate["column"], candidate["row"]
            if candidate["homeWorkers"] > 0:
                self.assertIn(coordinate, cells)
            else:
                self.assertEqual(candidate["crosswalkBlocks"], 0)
                self.assertNotIn(coordinate, cells)

    def test_depot_codes_preserve_existing_tile_assets(self) -> None:
        codes = json.loads((ROOT / "config/depot-codes.json").read_text(encoding="utf-8"))["tileCodes"]
        selection = load_selection(SELECTION_PATH)
        self.assertEqual(set(codes), set(selection.tile_ids))
        evidence = json.loads((ROOT.parents[1] / "worlds/nec-corridor/geography/expansion-evidence.json").read_text(encoding="utf-8"))
        new_tiles = {selection.coordinates[item["column"], item["row"]] for item in evidence["candidateCells"] if item["homeWorkers"] > 0}
        new_codes = []
        old_codes = []
        for tile_id, code in codes.items():
            if tile_id not in new_tiles:
                manifest_path = ROOT / "generated/maps/tiles" / tile_id / "map-manifest.json"
                self.assertEqual(code, json.loads(manifest_path.read_text(encoding="utf-8"))["cityCode"])
                old_codes.append(code)
            else:
                new_codes.append(code)
        self.assertEqual(len(new_codes), 23)
        self.assertEqual(len(new_codes), len(set(new_codes)))
        self.assertFalse(set(new_codes) & set(old_codes))

    def test_inconsistent_ownership_is_rejected(self) -> None:
        raw = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
        raw["selectedTiles"][0]["ownershipProjected"][0] += 1
        with self.assertRaisesRegex(ValueError, "ownershipProjected"):
            validate_selection(raw)


if __name__ == "__main__":
    unittest.main()
