from __future__ import annotations

import json
import unittest
from pathlib import Path

from nec_world_builder.catalog import build_catalog
from nec_world_builder.selection import load_selection, validate_selection


ROOT = Path(__file__).resolve().parents[1]
SELECTION_PATH = ROOT / "input" / "nec-corridor-selection.json"


class SelectionTests(unittest.TestCase):
    def test_attached_selection_is_frozen_to_the_new_york_grid(self) -> None:
        selection = load_selection(SELECTION_PATH)
        self.assertEqual(len(selection.tiles), 34)
        self.assertEqual(selection.grid.crs, "EPSG:26918")
        self.assertEqual(selection.grid.bounds(0, 0), (553400, 4483300, 631100, 4580600))
        self.assertEqual(selection.tile_id_at(553401, 4483301), "NEC_CP00_RP00")
        self.assertEqual(selection.tile_id_at(631100, 4483301), "NEC_CP01_RP00")
        self.assertIsNone(selection.tile_id_at(631101, 4775201))

    def test_catalog_has_selected_neighbors_and_geographic_bounds(self) -> None:
        selection = load_selection(SELECTION_PATH)
        catalog, coverage = build_catalog(selection)
        self.assertEqual(catalog["selection"]["selectedCount"], 34)
        self.assertEqual(len(catalog["tiles"]), 34)
        self.assertEqual(len(coverage["features"]), 34)
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
