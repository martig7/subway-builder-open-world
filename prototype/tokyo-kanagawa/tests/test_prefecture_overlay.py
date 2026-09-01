from __future__ import annotations

import json
import unittest
from pathlib import Path

from pyproj import Transformer
from shapely import coverage_is_valid
from shapely.geometry import shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT.parent / "japan" / "generated" / "tokyo-kanagawa-test" / "world-boundary-overlay.json"
PROJECT = Transformer.from_crs("EPSG:4326", "EPSG:6677", always_xy=True).transform


def vertex_count(geometry: object) -> int:
    parts = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    return sum(
        len(part.exterior.coords) + sum(len(interior.coords) for interior in part.interiors)
        for part in parts
    )


class PrefectureOverlayTest(unittest.TestCase):
    def test_overlay_is_smooth_and_topologically_non_overlapping(self) -> None:
        source = json.loads(OVERLAY.read_text(encoding="utf-8"))
        geometries = {
            feature["properties"]["pref_code"]: shape(feature["geometry"])
            for feature in source["features"]
        }
        metric = [transform(PROJECT, geometries[code]) for code in ("13", "14")]

        self.assertTrue(coverage_is_valid(metric))
        self.assertEqual(metric[0].intersection(metric[1]).area, 0)
        self.assertGreater(metric[0].boundary.intersection(metric[1].boundary).length, 100_000)
        self.assertGreater(vertex_count(geometries["13"]), 1_000)
        self.assertGreater(vertex_count(geometries["14"]), 1_000)


if __name__ == "__main__":
    unittest.main()
