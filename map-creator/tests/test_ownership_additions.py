import unittest
from shapely.geometry import box, mapping, shape
from open_world_map_creator.geography import apply_ownership_additions

def feature(code, geometry):
    return {'type':'Feature','properties':{'pref_code':code},'geometry':mapping(geometry)}

class OwnershipAdditionTests(unittest.TestCase):
    def test_only_named_owner_changes_and_addition_is_idempotent(self):
        source={'type':'FeatureCollection','features':[feature('28',box(0,0,1,1)),feature('27',box(1,0,2,1))]}
        extra={'type':'FeatureCollection','features':[feature('28',box(0,-.2,.1,-.1))]}
        result=apply_ownership_additions(source,extra)
        self.assertTrue(shape(result['features'][0]['geometry']).covers(box(0,-.2,.1,-.1)))
        self.assertEqual(result['features'][1],source['features'][1])
        self.assertEqual(apply_ownership_additions(result,extra),result)
        self.assertEqual(shape(source['features'][0]['geometry']).area,1)

    def test_addition_cannot_take_another_prefectures_land(self):
        source={'features':[feature('28',box(0,0,1,1)),feature('27',box(1,0,2,1))]}
        with self.assertRaisesRegex(ValueError,'overlap'):
            apply_ownership_additions(source,{'features':[feature('28',box(.5,0,1.5,1))]})
