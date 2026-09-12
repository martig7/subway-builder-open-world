from __future__ import annotations

import importlib.util
from decimal import Decimal
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "worlds/japan/data/noncommute/build_movement_table.py"
SPEC = importlib.util.spec_from_file_location("build_japan_noncommute", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class JapanNoncommuteMovementTableTest(unittest.TestCase):
    def test_national_blank_is_not_reported_zero(self) -> None:
        zones = [
            MODULE.NationalZone("11", "A", "01", 1),
            MODULE.NationalZone("21", "B", "02", 2),
        ]
        rows, counts = MODULE.build_national_rows(zones, [[0, ""], [0, 0]])
        self.assertEqual(counts["unreported_blank"], 1)
        self.assertEqual(counts["reported_zero"], 1)
        self.assertEqual(rows[0]["estimated_movements_per_weekday"], "")
        self.assertEqual(rows[1]["estimated_movements_per_weekday"], 0)

    def test_parse_correspondence_record(self) -> None:
        parsed = MODULE.parse_correspondence_record(
            "1道北 11旭川 1452上川支庁 鷹栖町", {"11"}
        )
        self.assertEqual(parsed, (1, "11", "01452", "上川支庁 鷹栖町"))

        numeric_name = MODULE.parse_correspondence_record(
            "13東京 13123区 13100特別区部", {"131"}
        )
        self.assertEqual(numeric_name, (13, "131", "13100", "特別区部"))

    def test_metropolitan_membership(self) -> None:
        self.assertTrue(MODULE.same_metro_group("13", "14"))
        self.assertTrue(MODULE.same_metro_group("23", "21"))
        self.assertTrue(MODULE.same_metro_group("13", "12"))
        self.assertFalse(MODULE.same_metro_group("13", "27"))

    def test_return_home_fraction_is_regional_and_conserved(self) -> None:
        records = [
            ("21", "23", "自由", 100),
            ("21", "23", "出勤", 300),
            ("21", "23", "帰宅", 80),
            ("21", "23", "不明", 7),
            ("21", "23", "計", 487),
            ("23", "21", "自由", 300),
            ("23", "21", "出勤", 100),
            ("23", "21", "帰宅", 40),
            ("23", "21", "不明", 3),
            ("23", "21", "計", 443),
            ("21", "24", "自由", 0),
            ("24", "21", "自由", 0),
            ("23", "24", "自由", 0),
            ("24", "23", "自由", 0),
        ]
        names = {"21": "Gifu", "23": "Aichi", "24": "Mie"}
        rows, report = MODULE.aggregate_region("chukyo", records, names)

        self.assertEqual(report["returnAllocationFraction"], "0.500000")
        self.assertEqual(len(rows), 6)
        outward = next(
            row
            for row in rows
            if row["origin_prefecture_code"] == "21"
            and row["destination_prefecture_code"] == "23"
        )
        self.assertEqual(Decimal(outward["estimated_movements_per_weekday"]), Decimal("140.000000"))
        self.assertEqual(outward["rounded_movements_per_weekday"], 140)
        self.assertEqual(outward["unknown_purpose_omitted"], 7)

    def test_region_rejects_unreconciled_purposes(self) -> None:
        records = [
            (origin, destination, "計", 1)
            for origin in ("21", "23", "24")
            for destination in ("21", "23", "24")
            if origin != destination
        ]
        with self.assertRaisesRegex(ValueError, "purpose components do not reconcile"):
            MODULE.aggregate_region("chukyo", records, {})


if __name__ == "__main__":
    unittest.main()
