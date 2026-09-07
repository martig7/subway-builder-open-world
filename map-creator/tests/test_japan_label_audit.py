import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("label_audit", Path(__file__).resolve().parents[1] / "scripts/audit_japan_labels.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


class LabelAuditTest(unittest.TestCase):
    def test_address_exclusions_do_not_remove_named_places(self):
        for name in ("城南一丁目", "今橋３丁目", "第百五十地割", "１５０番地", "Block 150", "150", "北一条西一丁目"):
            self.assertTrue(audit.address(name), name)
        for name in ("四日市市", "八王子市", "一宮市", "宇保町", "六本木", "三田市"):
            self.assertFalse(audit.address(name), name)

    def test_sakai_numbered_cho_preserves_named_districts(self):
        for name in ("三宝町五丁", "松屋大和川通五丁", "Sambo-cho 5-cho",
                     "KAISAN-CHO 7-CHO", "Kaisen １-chō", "Kaisen 1-chōme"):
            self.assertTrue(audit.address(name), name)
        for name in ("Teppo-cho", "三宝町", "鉄砲町", "八丁堀", "Cho 5"):
            self.assertFalse(audit.address(name), name)

    def test_only_explicit_latin_or_kana_readings(self):
        self.assertIsNone(audit.reading({"name": "日本橋"}))
        self.assertEqual(audit.reading({"name": "日本橋", "name:ja-Hira": "にほんばし"}), ("sourceKana", "name:ja-Hira", "にほんばし"))
        self.assertEqual(audit.reading({"name": "日本橋", "name:ja-Latn": "Nihonbashi", "name:en": "Japan Bridge"})[0], "sourceRomanized")
        self.assertIsNone(audit.reading({"name": "日本橋", "name:en": "日本橋", "name:ja-Hira": "日本ばし"}))
        self.assertFalse(audit.latin("Токио"))
        self.assertTrue(audit.latin("Tōkyō"))
        self.assertTrue(audit.kana("ニュータウン"))

    def test_matching_requires_location_and_reports_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "sources"
            sources.mkdir()
            names = ["日本橋", "宇保町", "上町", "下町", "北町", "南町", "城南一丁目"]
            labels = [{"name": name, "lon": 139, "lat": 35, "layer": "neighborhood_labels", "tiles": ["test"]} for name in names]
            nodes = [
                (1, "日本橋", 139, {"name:ja-Hira": "にほんばし"}),
                (2, "宇保町", 140, {"name:en": "Uhocho"}),
                (3, "上町", 139, {}),
                (4, "下町", 139, {"name:en": "Shitamachi"}),
                (4, "下町", 139, {"name:en": "Shimomachi"}),
                (5, "北町", 139, {"name:en": "Kitamachi"}),
                (6, "北町", 139, {"name:en": "Kitamachi"}),
                (7, "南町", 139, {"name:en": "Minamimachi"}),
            ]
            with gzip.open(sources / "source-00.jsonl.gz", "wt", encoding="utf-8") as f:
                for identifier, name, lon, fields in nodes:
                    f.write(json.dumps({"id": identifier, "lon": lon, "lat": 35, "tags": {"name": name, "place": "neighbourhood", **fields}}) + "\n")
            inventory = root / "inventory.jsonl.gz"
            with gzip.open(inventory, "wt", encoding="utf-8") as f:
                for label in labels:
                    f.write(json.dumps(label) + "\n")
            audit.compare(SimpleNamespace(sources=sources, inventory=inventory, output=root / "report"))
            report = json.loads((root / "report/summary.json").read_text())
            self.assertEqual(report["counts"], {"sourceKana": 1, "unmatchedSource": 1, "missingReading": 1,
                                               "conflictingReadings": 1, "ambiguousMatch": 1, "sourceEnglish": 1, "excludedAddress": 1})


if __name__ == "__main__":
    unittest.main()
