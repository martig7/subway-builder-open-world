import json
import tempfile
import unittest
from pathlib import Path
from shapely.geometry import box, mapping
from open_world_map_creator.demand.physical_land import PhysicalLandIndex

class PhysicalLandTests(unittest.TestCase):
    def test_water_holes_and_small_islands_are_preserved(self):
        land=box(0,0,1,1).difference(box(.4,.4,.6,.6))
        source={'purpose':'physical-land-computation','features':[{'geometry':mapping(land)},{'geometry':mapping(box(2,2,2.001,2.001))}]}
        index=PhysicalLandIndex(source)
        self.assertEqual(index.covers([[.1,.1],[.5,.5],[2.0005,2.0005],[3,3]]).tolist(),[True,False,True,False])
        self.assertEqual(index.covers([]).tolist(),[])

    def test_admin_geometry_is_not_a_physical_mask(self):
        with self.assertRaisesRegex(ValueError,'physical-land'):
            PhysicalLandIndex({'features':[{'geometry':mapping(box(0,0,1,1))}]})

    def test_validation_stamp_is_invalidated_by_source_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'land.geojson'
            source={'purpose':'physical-land-computation','features':[{'geometry':mapping(box(0,0,1,1))}]}
            path.write_text(json.dumps(source))
            PhysicalLandIndex.read(path)
            stamp=path.with_suffix('.geojson.validation.json')
            original=stamp.read_text()
            PhysicalLandIndex.read(path)
            self.assertEqual(stamp.read_text(),original)
            source['features'][0]['geometry']={'type':'Polygon','coordinates':[[[0,0],[1,1],[1,0],[0,1],[0,0]]]}
            path.write_text(json.dumps(source))
            with self.assertRaisesRegex(ValueError,'valid polygons'):
                PhysicalLandIndex.read(path)
