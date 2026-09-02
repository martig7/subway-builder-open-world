from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from open_world_map_creator.demand.estat_japan_prefecture import WORKER_VERSION
from open_world_map_creator.demand.japan_prefecture_queue import DEFAULT_QUEUE, REQUIRED_OUTPUTS, is_complete


class JapanPrefectureQueueTests(unittest.TestCase):
    def test_default_queue_covers_every_non_dedicated_prefecture_once(self) -> None:
        self.assertEqual(len(DEFAULT_QUEUE), 45)
        self.assertNotIn("13", DEFAULT_QUEUE)
        self.assertNotIn("14", DEFAULT_QUEUE)
        self.assertEqual(len(set(DEFAULT_QUEUE)), len(DEFAULT_QUEUE))

    def test_resume_requires_the_report_and_every_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for name in REQUIRED_OUTPUTS:
                (output / name).write_text("{}", encoding="utf-8")
            (output / "report.json").write_text(
                json.dumps({
                    "status": "demand-evidence-complete",
                    "workerVersion": WORKER_VERSION,
                    "renderBoundary": {"sha256": "current-boundary"},
                }),
                encoding="utf-8",
            )
            self.assertTrue(is_complete(output))
            self.assertTrue(is_complete(output, "current-boundary"))
            self.assertFalse(is_complete(output, "changed-boundary"))
            (output / "job-mesh-500m.geojson").unlink()
            self.assertFalse(is_complete(output))


if __name__ == "__main__":
    unittest.main()
