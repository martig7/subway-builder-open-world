import unittest
import shapely
from shapely.geometry import box, Polygon, mapping, shape
from open_world_map_creator.focus_vegetation import focus_vegetation, vegetation_footprint


class FocusVegetationTests(unittest.TestCase):
    def test_complex_world_coast_does_not_become_complex_vegetation_geometry(self):
        coast = [(i / 1000, .001 * (i % 2)) for i in range(1001)]
        mask = Polygon([*coast, (1, 1), (0, 1)])
        protected = vegetation_footprint(mask)
        self.assertTrue(protected.covers(mask))
        self.assertLess(shapely.get_num_coordinates(protected), 50)

    def test_country_detail_and_holes_survive_while_foreign_small_patches_disappear(self):
        mask = box(0, 0, 2, 2)
        domestic = box(.1, .1, 1.9, 1.9).difference(box(.4, .4, .5, .5))
        cross_border = Polygon([(1, 1), (3, 1), (3, 1.4), (2.8, 1.41), (3, 1.42), (3, 1.8), (1, 1.8)])
        foreign_tiny = box(5, 5, 5.01, 5.01)
        geometries = [domestic, cross_border, foreign_tiny]
        source = {'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'properties': {}, 'geometry': mapping(g)} for g in geometries]}
        result = focus_vegetation(source, mask, 'XX', tolerance=.2, minimum_area=.02)
        actual = shapely.union_all([shape(f['geometry']) for f in result['features']])
        original = shapely.union_all(geometries)
        self.assertLess(actual.intersection(mask).symmetric_difference(original.intersection(mask)).area, 1e-12)
        self.assertEqual(actual.intersection(foreign_tiny).area, 0)
        self.assertTrue(actual.is_valid)
        self.assertEqual(result['focusWorld'], 'XX')

    def test_empty_country_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'world mask'):
            focus_vegetation({'features': []}, Polygon(), 'XX')
