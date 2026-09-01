from __future__ import annotations

import gzip
import struct
import tempfile
import unittest
from pathlib import Path

from scripts.building_seed_voronoi import (
    BINARY_MAGIC,
    HEADER_SIZE,
    cluster_building_seeds,
    read_building_centers,
)


class IdentityTransformer:
    def transform(self, x_values, y_values):
        return x_values, y_values


class BuildingSeedVoronoiTest(unittest.TestCase):
    def test_building_index_reader_uses_building_centers(self) -> None:
        header = bytearray(HEADER_SIZE)
        struct.pack_into("<I", header, 0, BINARY_MAGIC)
        header[4] = 1
        struct.pack_into("<I", header, 8, 2)
        struct.pack_into("<d", header, 40, 0.0009)
        bounds = struct.pack("<8d", 139.0, 35.0, 139.2, 35.2, 140.0, 36.0, 140.2, 36.2)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "buildings_index.bin.gz"
            with gzip.open(path, "wb") as output:
                output.write(header)
                output.write(bounds)
            buildings = read_building_centers(path, [138.0, 34.0, 141.0, 37.0], IdentityTransformer())

        self.assertEqual(buildings["sourceIds"].tolist(), [0, 1])
        self.assertEqual(buildings["longitudes"].tolist(), [139.1, 140.1])
        self.assertEqual(buildings["latitudes"].tolist(), [35.1, 36.1])
        self.assertEqual(buildings["cellSizeDegrees"], 0.0009)

    def test_voronoi_centroid_is_snapped_to_a_member_building(self) -> None:
        fine_seeds = [
            {"id": "a", "x": 0.0, "y": 0.0, "longitude": 139.0011, "latitude": 35.0013, "weight": 90},
            {"id": "b", "x": 80.0, "y": 35.0, "longitude": 139.0027, "latitude": 35.0019, "weight": 110},
            {"id": "c", "x": 900.0, "y": 500.0, "longitude": 139.0137, "latitude": 35.0061, "weight": 75},
        ]
        sites, report = cluster_building_seeds("TEST", fine_seeds, 200.0)

        anchors = {(seed["longitude"], seed["latitude"]) for seed in fine_seeds}
        self.assertEqual(sum(site["commuters"] for site in sites), 275)
        self.assertTrue(all(tuple(site["location"]) in anchors for site in sites))
        self.assertEqual(report["unanchoredSiteCount"], 0)


if __name__ == "__main__":
    unittest.main()
