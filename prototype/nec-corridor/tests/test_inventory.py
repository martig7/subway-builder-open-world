from __future__ import annotations

import csv
import gzip
import tempfile
import unittest
from pathlib import Path

from pyproj import Transformer

from nec_world_builder.inventory import inventory_lodes
from nec_world_builder.selection import load_selection


ROOT = Path(__file__).resolve().parents[1]
SELECTION_PATH = ROOT / "input" / "nec-corridor-selection.json"


def _write_gzip_csv(path: Path, fieldnames: list[str], rows: list[dict[str, object]]) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


class InventoryTests(unittest.TestCase):
    def test_main_and_auxiliary_rows_are_classified_without_double_counting(self) -> None:
        selection = load_selection(SELECTION_PATH)
        inverse = Transformer.from_crs(selection.grid.crs, "EPSG:4326", always_xy=True)

        def lon_lat(x: float, y: float) -> tuple[float, float]:
            return inverse.transform(x, y)

        local_lon, local_lat = lon_lat(553500, 4483400)
        east_lon, east_lat = lon_lat(708900, 4483400)
        external_lon, external_lat = lon_lat(950000, 4000000)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            crosswalk = root / "ny_xwalk.csv.gz"
            _write_gzip_csv(
                crosswalk,
                ["tabblk2020", "blklatdd", "blklondd"],
                [
                    {"tabblk2020": "360000000000001", "blklatdd": local_lat, "blklondd": local_lon},
                    {"tabblk2020": "360000000000002", "blklatdd": local_lat, "blklondd": east_lon},
                    {"tabblk2020": "360000000000003", "blklatdd": east_lat, "blklondd": east_lon},
                ],
            )
            main = root / "ny_od_main_JT01_2023.csv.gz"
            _write_gzip_csv(
                main,
                ["h_geocode", "w_geocode", "S000", "createdate"],
                [
                    {"h_geocode": "360000000000001", "w_geocode": "360000000000001", "S000": 5, "createdate": "20251202"},
                    {"h_geocode": "360000000000001", "w_geocode": "360000000000003", "S000": 7, "createdate": "20251202"},
                ],
            )
            inbound = root / "ny_od_aux_JT01_2023.csv.gz"
            _write_gzip_csv(
                inbound,
                ["h_geocode", "w_geocode", "S000", "createdate"],
                [{"h_geocode": "240000000000004", "w_geocode": "360000000000001", "S000": 11, "createdate": "20251202"}],
            )
            outbound = root / "dc_od_aux_JT01_2023.csv.gz"
            _write_gzip_csv(
                outbound,
                ["h_geocode", "w_geocode", "S000", "createdate"],
                [{"h_geocode": "360000000000001", "w_geocode": "110000000000005", "S000": 13, "createdate": "20251202"}],
            )

            report = inventory_lodes(
                selection,
                [("36", crosswalk)],
                [("36", main)],
                [("36", inbound), ("11", outbound)],
            )
            map_report = inventory_lodes(
                selection,
                [("36", crosswalk)],
                [("36", main)],
                [("36", inbound), ("11", outbound)],
                map_only=True,
            )

        self.assertEqual(report["totals"]["inputRows"], 4)
        self.assertEqual(report["totals"]["inputWorkers"], 36)
        self.assertEqual(report["totals"]["classificationWorkerDelta"], 0)
        self.assertEqual(report["categories"]["local"]["workers"], 5)
        self.assertEqual(report["categories"]["corridorCrossTile"]["workers"], 7)
        self.assertEqual(report["categories"]["externalInbound"]["workers"], 11)
        self.assertEqual(report["categories"]["externalOutbound"]["workers"], 13)
        self.assertEqual(map_report["scope"], "selected-tile-pairs")
        self.assertEqual(map_report["totals"]["scannedWorkers"], 36)
        self.assertEqual(map_report["totals"]["inputWorkers"], 12)
        self.assertEqual(map_report["totals"]["excludedWorkers"], 24)
        self.assertEqual(set(map_report["categories"]), {"local", "corridorCrossTile"})


if __name__ == "__main__":
    unittest.main()
