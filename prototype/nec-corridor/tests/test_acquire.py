from __future__ import annotations

import json
import unittest
from pathlib import Path

from nec_world_builder.acquire import lodes_manifest


ROOT = Path(__file__).resolve().parents[1]


class AcquisitionTests(unittest.TestCase):
    def test_manifest_expands_all_three_files_for_each_workplace_state(self) -> None:
        lock = json.loads((ROOT / "config" / "sources.lock.json").read_text(encoding="utf-8"))
        config = json.loads((ROOT / "config" / "world-nec.json").read_text(encoding="utf-8"))
        states = [state.lower() for state in config["states"]["workplaceJurisdictions"]]
        manifest = lodes_manifest(lock, states)
        self.assertEqual(len(manifest), 42)
        self.assertEqual({record["state"] for record in manifest}, set(states))
        self.assertEqual(
            {record["role"] for record in manifest},
            {"lodes-main", "lodes-aux", "lodes-crosswalk"},
        )
        self.assertTrue(all("{state}" not in record["url"] for record in manifest))

    def test_auxiliary_role_filter_expands_grid_states(self) -> None:
        lock = json.loads((ROOT / "config" / "sources.lock.json").read_text(encoding="utf-8"))
        manifest = lodes_manifest(lock, roles=["lodes-aux"])
        self.assertEqual(len(manifest), 14)
        self.assertEqual({record["role"] for record in manifest}, {"lodes-aux"})

    def test_manifest_rejects_states_outside_the_lock(self) -> None:
        lock = json.loads((ROOT / "config" / "sources.lock.json").read_text(encoding="utf-8"))
        with self.assertRaises(ValueError):
            lodes_manifest(lock, ["xx"])


if __name__ == "__main__":
    unittest.main()
