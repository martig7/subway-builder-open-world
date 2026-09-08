import unittest
import shapely
from shapely.geometry import box, Polygon, shape
from open_world_map_creator.geography import shared_dividers


class InlandDividerTests(unittest.TestCase):
    def test_coast_and_point_contacts_are_excluded_and_shared_edges_draw_once(self):
        geometries = [box(0, 0, 1, 1), box(1, 0, 2, 1), box(2, 1, 3, 2), box(5, 5, 6, 6)]
        result = shared_dividers(geometries, ['A', 'B', 'C', 'island'])
        self.assertEqual(len(result['features']), 1)
        feature = result['features'][0]
        self.assertEqual(feature['properties']['owners'], ['A', 'B'])
        self.assertAlmostEqual(shape(feature['geometry']).length, 1)
        self.assertAlmostEqual(shape(feature['geometry']).intersection(shapely.union_all(geometries).boundary).length, 0)

    def test_enclave_border_is_kept_but_unowned_lake_is_not(self):
        enclave = box(1, 1, 2, 2)
        lake = box(3, 3, 4, 4)
        outer = box(0, 0, 5, 5).difference(enclave.union(lake))
        result = shared_dividers([outer, enclave], ['outer', 'inner'])
        self.assertEqual(len(result['features']), 1)
        self.assertTrue(shape(result['features'][0]['geometry']).equals(enclave.boundary))
