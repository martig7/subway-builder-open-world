import json
import unittest
import shapely
from shapely.geometry import Polygon, mapping, shape
from open_world_map_creator.geography import quantize_display_overlay


class DisplayQuantizationTests(unittest.TestCase):
    def test_narrow_slivers_are_repaired_and_shared_edges_stay_shared(self):
        left = Polygon([(0, 0), (1.000004, 0), (1.000006, 1), (0, 1)])
        right = Polygon([(1.000004, 0), (2, 0), (2, 1), (1.000006, 1)])
        features = [{'type': 'Feature', 'properties': {'id': i}, 'geometry': mapping(g)}
                    for i, g in enumerate([left, right])]
        source = {'purpose': 'display-only', 'lods': [{'features': features}]}
        before = json.dumps(source)
        output = quantize_display_overlay(source)
        geometries = [shape(f['geometry']) for f in output['features']]
        self.assertTrue(all(g.is_valid for g in geometries))
        self.assertTrue(shapely.coverage_is_valid(geometries))
        self.assertGreater(geometries[0].boundary.intersection(geometries[1].boundary).length, .99)
        self.assertEqual(json.dumps(source), before)
        self.assertIs(output['features'], output['lods'][0]['features'])

    def test_authoritative_geometry_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'display-only'):
            quantize_display_overlay({'type': 'FeatureCollection', 'features': []})
