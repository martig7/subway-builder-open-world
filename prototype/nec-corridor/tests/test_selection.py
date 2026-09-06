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
        self.assertEqual(len(selection.tiles), 35)
        self.assertEqual(selection.grid.crs, "EPSG:26918")
        self.assertEqual(selection.grid.bounds(0, 0), (553400, 4483300, 631100, 4580600))
        self.assertEqual(selection.tile_id_at(553401, 4483301), "NEC_CP00_RP00")
        self.assertEqual(selection.tile_id_at(631100, 4483301), "NEC_CP01_RP00")
        self.assertIsNone(selection.tile_id_at(631101, 4775201))

    def test_catalog_has_selected_neighbors_and_geographic_bounds(self) -> None:
        selection = load_selection(SELECTION_PATH)
        catalog, coverage = build_catalog(selection)
        self.assertEqual(catalog["selection"]["selectedCount"], 35)
        self.assertEqual(len(catalog["tiles"]), 35)
        self.assertEqual(len(coverage["features"]), 35)
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

    def test_inconsistent_ownership_is_rejected(self) -> None:
        raw = json.loads(SELECTION_PATH.read_text(encoding="utf-8"))
        raw["selectedTiles"][0]["ownershipProjected"][0] += 1
        with self.assertRaisesRegex(ValueError, "ownershipProjected"):
            validate_selection(raw)


if __name__ == "__main__":
    unittest.main()
