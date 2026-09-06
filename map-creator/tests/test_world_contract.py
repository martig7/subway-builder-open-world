from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from open_world_map_creator.worlds import load_world, validate_world_definition


ROOT = Path(__file__).resolve().parents[2]


class WorldContractTests(unittest.TestCase):
    def test_every_real_world_uses_the_shared_contract(self) -> None:
        for name in ("nec-corridor", "tokyo-kanagawa", "ny-state", "japan"):
            with self.subTest(world=name):
                self.assertTrue(load_world(ROOT / "worlds" / name).selected_tiles)

    def test_python_rejects_the_same_malformed_definitions_as_javascript(self) -> None:
        original = json.loads((ROOT / "worlds/japan/world.json").read_text(encoding="utf-8"))
        cases = json.loads((ROOT / "open-world-platform/testkit/fixtures/world-definition-cases.json").read_text(encoding="utf-8"))
        for fixture in cases:
            with self.subTest(case=fixture["name"]):
                definition = copy.deepcopy(original)
                parent = definition
                for key in fixture["path"][:-1]:
                    parent = parent[key]
                if fixture.get("remove"):
                    del parent[fixture["path"][-1]]
                else:
                    parent[fixture["path"][-1]] = fixture["value"]
                with self.assertRaises(ValueError):
                    validate_world_definition(definition)


if __name__ == "__main__":
    unittest.main()
