from __future__ import annotations

import gzip
import json
import unittest
from collections import Counter
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import Point, shape


ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "generated"
TILE_IDS = ("JP_TOKYO_MAINLAND", "JP_KANAGAWA_MAINLAND")
TILES = {
    "JP_TOKYO_MAINLAND": {"prefCode": "13", "bounds": [138.95, 35.35, 140.05, 36.05]},
    "JP_KANAGAWA_MAINLAND": {"prefCode": "14", "bounds": [138.85, 35.05, 139.95, 35.75]},
}
TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:6677", always_xy=True)


def load_demand(tile_id: str) -> dict:
    path = GENERATED / "demand" / "tiles" / tile_id / "demand_data.json.gz"
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def lattice_alignment_fraction(points: list[dict]) -> float:
    latitudes = Counter(round(point["location"][1], 7) for point in points)
    longitudes = Counter(round(point["location"][0], 7) for point in points)
    aligned = sum(
        latitudes[round(point["location"][1], 7)] > 1
        or longitudes[round(point["location"][0], 7)] > 1
        for point in points
    )
    return aligned / len(points)


def projected_points(points: list[dict]) -> np.ndarray:
    locations = np.asarray([point["location"] for point in points], dtype=np.float64)
    x_values, y_values = TRANSFORMER.transform(locations[:, 0], locations[:, 1])
    return np.column_stack((x_values, y_values))


def directional_concentration(points: list[dict]) -> float:
    coordinates = projected_points(points)
    _, neighbors = cKDTree(coordinates).query(coordinates, k=5)
    vectors = coordinates[neighbors[:, 1:]] - coordinates[:, np.newaxis, :]
    directions = np.mod(np.arctan2(vectors[:, :, 1], vectors[:, :, 0]), np.pi)
    histogram, _ = np.histogram(directions, bins=36, range=(0, np.pi))
    return float(np.sort(histogram)[-4:].sum() / histogram.sum())


class DemandSiteGeometryTest(unittest.TestCase):
    def test_final_sites_are_irregular_and_building_anchored(self) -> None:
        source_mesh = json.loads(
            (ROOT.parent / "japan" / "generated" / "tokyo-kanagawa-test" / "home-mesh-250m.geojson").read_text(
                encoding="utf-8"
            )
        )
        mesh_centers = {
            tuple(feature["geometry"]["coordinates"])
            for feature in source_mesh["features"]
        }
        for tile_id in TILE_IDS:
            points = load_demand(tile_id)["points"]
            self.assertLess(
                lattice_alignment_fraction(points),
                0.25,
                f"{tile_id} demand points still expose the source mesh lattice",
            )
            raw_centroid_fraction = sum(tuple(point["location"]) in mesh_centers for point in points) / len(points)
            self.assertLess(
                raw_centroid_fraction,
                0.01,
                f"{tile_id} demand points are still located at raw 250 m census centroids",
            )

        report = json.loads(
            (GENERATED / "demand" / "reports" / "tokyo-kanagawa-demand.json").read_text(encoding="utf-8")
        )
        self.assertEqual(report["aggregation"]["fineSeedSource"], "osm-building-index-v1")
        self.assertEqual(report["aggregation"]["finalSiteAnchor"], "member-building-center")
        self.assertEqual(report["aggregation"]["unanchoredSiteCount"], 0)

    def test_nearest_neighbor_directions_do_not_preserve_mesh_axes(self) -> None:
        for tile_id in TILE_IDS:
            score = directional_concentration(load_demand(tile_id)["points"])
            self.assertLess(
                score,
                0.20,
                f"{tile_id} nearest-neighbor directions still expose diagonal census-grid axes",
            )

    def test_employment_cells_are_covered_by_demand_sites(self) -> None:
        source_root = ROOT.parent / "japan" / "generated" / "tokyo-kanagawa-test"
        boundaries = {
            feature["properties"]["pref_code"]: shape(feature["geometry"])
            for feature in json.loads((source_root / "world-boundary.geojson").read_text(encoding="utf-8"))["features"]
        }
        job_features = json.loads((source_root / "job-mesh-500m.geojson").read_text(encoding="utf-8"))["features"]
        for tile_id, tile in TILES.items():
            min_lon, min_lat, max_lon, max_lat = tile["bounds"]
            rows = [
                feature
                for feature in job_features
                if min_lon <= feature["geometry"]["coordinates"][0] <= max_lon
                and min_lat <= feature["geometry"]["coordinates"][1] <= max_lat
                and (
                    feature["properties"].get("prefCode") == tile["prefCode"]
                    if feature["properties"].get("prefCode")
                    else boundaries[tile["prefCode"]].covers(Point(*feature["geometry"]["coordinates"]))
                )
            ]
            locations = np.asarray([feature["geometry"]["coordinates"] for feature in rows], dtype=np.float64)
            x_values, y_values = TRANSFORMER.transform(locations[:, 0], locations[:, 1])
            distances, _ = cKDTree(projected_points(load_demand(tile_id)["points"])).query(
                np.column_stack((x_values, y_values)), k=1
            )
            weights = np.asarray([feature["properties"]["jobs"] for feature in rows], dtype=np.float64)
            uncovered_fraction = float(weights[distances > 600].sum() / weights.sum())
            self.assertLess(
                uncovered_fraction,
                0.02,
                f"{tile_id} leaves too much employment demand more than 600 m from a site",
            )


if __name__ == "__main__":
    unittest.main()
