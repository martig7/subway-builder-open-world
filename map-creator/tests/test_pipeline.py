from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from open_world_map_creator.pipeline import build_world
from open_world_map_creator.stages import plan_world
from open_world_map_creator.storage import DataRoot


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class PipelineTests(unittest.TestCase):
    def test_plan_is_read_only_and_selects_one_tile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            data_root = DataRoot(Path(directory) / "data")
            world, plans = plan_world(REPOSITORY_ROOT / "worlds" / "tokyo-kanagawa", data_root, "JP_TOKYO_MAINLAND")
            self.assertEqual(world.definition["identity"]["worldId"], "tokyo-kanagawa-world")
            self.assertEqual(plans[0].status, "stale")
            self.assertTrue(all(plan.status == "blocked" for plan in plans[1:]))
            self.assertFalse(data_root.root.exists())

    def test_runner_adapters_produce_equivalent_verified_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            world_root = REPOSITORY_ROOT / "worlds" / "tokyo-kanagawa"
            world, plans = plan_world(world_root, DataRoot(Path(directory) / "plan"), "JP_TOKYO_MAINLAND")
            manifest = {
                "schemaVersion": 1,
                "worldRoot": str(world.root),
                "worldDefinitionHash": world.definition_hash,
                "stage": "validate",
                "stageKey": plans[0].key,
                "tileId": "JP_TOKYO_MAINLAND",
            }
            from open_world_map_creator.runners import InProcessRunner, SubprocessRunner
            self.assertEqual(InProcessRunner().run(manifest), SubprocessRunner().run(manifest))

    def test_third_prefecture_plans_without_implementation_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            world, plans = plan_world(
                REPOSITORY_ROOT / "worlds" / "japan",
                DataRoot(Path(directory) / "data"),
                "JP_PREF_11",
            )
            self.assertEqual(len(world.tile_views), 47)
            self.assertEqual(world.definition["demand"]["adapter"], "estat-japan")
            self.assertEqual(plans[0].status, "stale")
            self.assertTrue(all(plan.status == "blocked" for plan in plans[1:]))


if __name__ == "__main__":
    unittest.main()
