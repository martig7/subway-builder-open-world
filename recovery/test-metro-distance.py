import math
from pathlib import Path
import runpy
import unittest


distance = runpy.run_path(str(Path(__file__).with_name('build-japan-stress-save.py')))['distance']


class NativeDistanceTests(unittest.TestCase):
    def test_observed_native_speed_cache_segment(self):
        # Independently measured through the running game's trackSpeedsMap.
        self.assertAlmostEqual(distance([139.733368, 35.703311], [139.734537, 35.702278]), 156.00019869880288, places=6)

    def test_antimeridian_and_zero_distance(self):
        self.assertAlmostEqual(distance([179.9, 0], [-179.9, 0]), 6371008.8 * math.radians(0.2), places=5)
        self.assertEqual(distance([139, 35], [139, 35]), 0)


if __name__ == '__main__':
    unittest.main()
