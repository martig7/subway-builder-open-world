import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'merge_building_supplement',
    Path(__file__).resolve().parents[1] / 'scripts' / 'merge_japan_building_supplement.py',
)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class BuildingSupplementImportTests(unittest.TestCase):
    def test_atomic_write_retains_original_when_replacement_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'footprints.json'
            target.write_text('{"original":true}', encoding='utf-8')
            with patch.object(importer.os, 'replace', side_effect=OSError('locked')):
                with self.assertRaises(OSError):
                    importer.write_compact_atomic(target, {'new': True})
            self.assertEqual(json.loads(target.read_text()), {'original': True})
            importer.write_compact_atomic(target, {'new': True})
            self.assertEqual(json.loads(target.read_text()), {'new': True})

    def test_footprint_replay_identity_ignores_json_key_order(self):
        self.assertEqual(
            importer.footprint_key({'geometry': {'coordinates': [1, 2]}, 'type': 'Feature'}),
            importer.footprint_key({'type': 'Feature', 'geometry': {'coordinates': [1, 2]}}),
        )
