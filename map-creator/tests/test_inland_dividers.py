import unittest
import shapely
from shapely.geometry import box, Polygon, shape
from open_world_map_creator.geography import shared_dividers, offshore_selection


class InlandDividerTests(unittest.TestCase):
    def test_offshore_selection_keeps_real_enclaves_and_only_adds_unowned_area(self):
        enclave = box(3, 3, 4, 4)
        original = [box(0, 0, 5, 5).difference(enclave), enclave, box(5, 0, 10, 5)]
        expanded = offshore_selection(original, 2)
        for owner, selected in enumerate(expanded):
            self.assertTrue(selected.covers(original[owner]))
            self.assertTrue(selected.is_valid)
            for other in range(len(original)):
                if other != owner:
                    self.assertLess(selected.intersection(original[other]).area, 1e-10)
                    self.assertLess(selected.intersection(expanded[other]).area, 1e-10)
        self.assertTrue(expanded[1].equals(enclave))
        self.assertGreater(expanded[0].area, original[0].area)

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
