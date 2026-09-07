import gzip
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import publish_japan_labels as publish
from mapbox_vector_tile.Mapbox import vector_tile_pb2


class LabelPublicationTest(unittest.TestCase):
    def lookup(self, root):
        rows = [
            {"name": "東京", "category": "sourceRomanized", "match": {"value": "Tokyo"}},
            {"name": "読み不明", "category": "missingReading"},
            {"name": "日本橋", "category": "sourceKana", "match": {"value": "にほんばし"}},
            {"name": "緑町1", "category": "sourceEnglish", "match": {"value": "Midoricho 1-chome"}},
        ]
        path = root / "matches.gz"
        with gzip.open(path, "wt", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps({**row, "layer": "city_labels", "lon": 0, "lat": 0}) + "\n")
        return publish.LabelLookup(path)

    def test_source_only_conversion_and_japanese_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            lookup = self.lookup(Path(temporary))
            self.assertEqual(lookup.name("city_labels", "東京", .5, .5, 4096), "Tokyo")
            self.assertEqual(lookup.name("city_labels", "東京", .1, .1, 4096), "東京")
            self.assertEqual(lookup.name("city_labels", "読み不明", .5, .5, 4096), "読み不明")
            self.assertEqual(lookup.name("city_labels", "日本橋", .5, .5, 4096), "Nihonbashi")
            lookup.index[("city_labels", "東京")].append((.5, .5, "Conflicting"))
            self.assertEqual(lookup.name("city_labels", "東京", .5, .5, 4096), "東京")

    def test_transform_preserves_geometry_and_non_label_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            lookup = self.lookup(Path(temporary))
            tile = vector_tile_pb2.tile()
            water = tile.layers.add(name="water", version=2, extent=4096)
            water.features.add(id=29, type=3, geometry=[9, 2, 4, 15])
            labels = tile.layers.add(name="city_labels", version=2, extent=4096)
            labels.keys.append("name")
            for i, name in enumerate(("東京", "読み不明", "城南一丁目", "緑町1", "三宝町五丁", "Sambo-cho 5-cho", "Teppo-cho")):
                labels.values.add(string_value=name)
                labels.features.add(id=i + 1, type=1, tags=[0, i], geometry=[9, 4096, 4096])
            raw = tile.SerializeToString()
            counts = publish.Counter()
            result = publish.transform(raw, (0, 0, 0), lookup, counts)
            self.assertEqual(publish.invariants(raw, True, (0, 0, 0), lookup), publish.invariants(result, False))
            decoded = vector_tile_pb2.tile()
            decoded.ParseFromString(result)
            self.assertEqual(decoded.layers[0].SerializeToString(), water.SerializeToString())
            self.assertEqual([v.string_value for v in decoded.layers[1].values], ["Tokyo", "読み不明", "Teppo-cho"])
            self.assertEqual(counts["removedAddressOccurrences"], 4)
            changed = vector_tile_pb2.tile()
            changed.ParseFromString(result)
            changed.layers[0].features[0].id = 30
            self.assertNotEqual(publish.invariants(raw, True), publish.invariants(changed.SerializeToString(), False))

    def test_low_zoom_world_wrap_multipoint_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            lookup = self.lookup(Path(temporary))
            tile = vector_tile_pb2.tile()
            layer = tile.layers.add(name="city_labels", version=2, extent=4096)
            layer.keys.append("name")
            layer.values.add(string_value="Unmatched city")
            layer.features.add(type=1, tags=[0, 0], geometry=[17, 10, 1768, 8192, 0])
            raw = tile.SerializeToString()
            result = publish.transform(raw, (0, 0, 0), lookup, publish.Counter())
            self.assertEqual(publish.invariants(raw, True, (0, 0, 0), lookup), publish.invariants(result, False))


if __name__ == "__main__":
    unittest.main()
