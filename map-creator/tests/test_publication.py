from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from open_world_map_creator.publication import publish_artifact_set
from open_world_map_creator.storage import DataRoot
from open_world_map_creator.worlds import load_world


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class PublicationTests(unittest.TestCase):
    def test_publication_fails_closed_without_verified_packages(self) -> None:
        world_root = REPOSITORY_ROOT / "worlds" / "tokyo-kanagawa"
        world = load_world(world_root)
        with tempfile.TemporaryDirectory() as directory:
            run_path = Path(directory) / "run.json"
            run_path.write_text(json.dumps({"worldDefinitionHash": world.definition_hash, "results": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no verified Tile Packages"):
                publish_artifact_set(world_root, run_path, DataRoot(Path(directory) / "data"))


if __name__ == "__main__":
    unittest.main()
