from __future__ import annotations

import unittest

from nec_world_builder.metrics import build_tile_metrics


class MetricsTests(unittest.TestCase):
    def test_tile_metrics_derive_directional_cross_tile_totals(self) -> None:
        inventory = {
            "worldId": "NEC_CORRIDOR_LODES_PROTOTYPE",
            "scope": "selected-tile-pairs",
            "source": {"vintage": 2023},
            "selection": {"tileCount": 2, "tileIds": ["A", "B"]},
            "totals": {
                "scannedRows": 10,
                "scannedWorkers": 100,
                "excludedRows": 2,
                "excludedWorkers": 20,
                "inputRows": 8,
                "inputWorkers": 80,
                "classificationRowDelta": 0,
                "classificationWorkerDelta": 0,
            },
            "categories": {
                "local": {"rows": 5, "workers": 50},
                "corridorCrossTile": {"rows": 3, "workers": 30},
            },
            "tiles": [
                {"tileId": "A", "homeWorkers": 40, "workWorkers": 45, "localWorkers": 30, "activityWorkers": 85},
                {"tileId": "B", "homeWorkers": 40, "workWorkers": 35, "localWorkers": 20, "activityWorkers": 75},
            ],
            "tilePairs": [
                {"homeTileId": "A", "workTileId": "A", "rows": 5, "workers": 50},
                {"homeTileId": "A", "workTileId": "B", "rows": 2, "workers": 20},
                {"homeTileId": "B", "workTileId": "A", "rows": 1, "workers": 10},
            ],
        }
        report, pairs = build_tile_metrics(inventory)
        by_id = {tile["tileId"]: tile for tile in report["tiles"]}
        self.assertEqual(by_id["A"]["corridorOutboundWorkers"], 20)
        self.assertEqual(by_id["A"]["corridorInboundWorkers"], 10)
        self.assertEqual(by_id["B"]["corridorOutboundWorkers"], 10)
        self.assertEqual(by_id["B"]["corridorInboundWorkers"], 20)
        self.assertEqual(report["totals"]["retainedWorkers"], 80)
        self.assertEqual(len(pairs), 3)


if __name__ == "__main__":
    unittest.main()
