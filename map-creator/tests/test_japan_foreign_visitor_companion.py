from __future__ import annotations

import csv
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "worlds/japan/data/noncommute/build_foreign_visitor_companion.py"
SPEC = importlib.util.spec_from_file_location("build_japan_foreign_visitor_companion", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class JapanForeignVisitorCompanionTest(unittest.TestCase):
    def test_thousand_person_cells_are_exactly_converted(self) -> None:
        self.assertEqual(MODULE.annual_visitor_legs(12.345), 12345)
        self.assertEqual(MODULE.annual_visitor_legs(0), 0)

    def test_missing_or_fractional_person_cells_fail(self) -> None:
        for value in (None, "", -1, 0.0001):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.annual_visitor_legs(value)

    def test_foreign_visitor_pairs_are_only_internal_metro_pairs(self) -> None:
        pairs = {
            (origin, destination)
            for members in MODULE.REGIONS.values()
            for origin in members
            for destination in members
            if origin != destination
        }
        self.assertEqual(len(pairs), 30)
        self.assertNotIn(("13", "27"), pairs)
        with (ROOT / "worlds/japan/data/noncommute/movements.csv").open(
            encoding="utf-8", newline=""
        ) as handle:
            baseline_pairs = {
                (row["origin_prefecture_code"], row["destination_prefecture_code"])
                for row in csv.DictReader(handle)
                if row["zone_level"] == "prefecture"
            }
        self.assertEqual(pairs, baseline_pairs)


if __name__ == "__main__":
    unittest.main()
