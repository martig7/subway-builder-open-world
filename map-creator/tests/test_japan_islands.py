import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stdout
import io

from shapely.geometry import MultiPolygon, Point, box, mapping, shape

spec = importlib.util.spec_from_file_location('japan_catalog', Path(__file__).resolve().parents[1]/'scripts/build_japan_world_catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class JapanIslandTests(unittest.TestCase):
    def test_detailed_ownership_keeps_small_islands_by_default(self):
        mainland = box(135,34,135.1,34.1)
        island = box(135.15,34.01,135.153,34.013)
        source = {'type':'FeatureCollection','features':[{'type':'Feature','properties':{'pref_code':'27'},
            'geometry':mapping(MultiPolygon([mainland,island]))}]}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'source.geojson'
            path.write_text(json.dumps(source))
            with redirect_stdout(io.StringIO()):
                result = catalog.build_overlay(path,10)
        self.assertTrue(shape(result['features'][0]['geometry']).covers(Point(135.1515,34.0115)),
                        'Detailed ownership discarded an inhabited-scale small island')
        self.assertEqual(result['features'][0]['properties']['minimum_island_area_km2'],0)
