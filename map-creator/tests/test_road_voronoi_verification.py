import gzip
import json
from pathlib import Path
import tempfile
import unittest

from shapely.geometry import box, mapping

from open_world_map_creator.demand.verify_japan import sha256, verify


def fixture(root, *, cross_mass=50, close=False):
    world, demand = root/'world', root/'demand'

    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(value).encode()
        path.write_bytes(gzip.compress(raw) if path.suffix == '.gz' else raw)

    locations = [[135.009 if close else 135.001,34.005],[135.011 if close else 135.025,34.005]]
    tiles = ['JP_PREF_27','JP_PREF_28']
    boundary = world/'geography/prefectures.geojson'
    write(world/'world.json', {'tileViews':{'ownershipBoundary':'geography/prefectures.geojson'}})
    write(world/'demand.json', {})
    write(boundary, {'type':'FeatureCollection','features':[
        {'type':'Feature','properties':{'pref_code':code},'geometry':mapping(polygon)}
        for code,polygon in [('27',box(135,34,135.01,34.02)),('28',box(135.01,34,135.03,34.02))]]})
    write(world/'geography/tile-views.json', {'tiles':[
        {'id':tile,'prefCode':code,'status':'selected'} for tile,code in zip(tiles,['27','28'])]})
    for i,tile in enumerate(tiles):
        path = demand/'tiles'/tile/'demand_data.json.gz'
        write(path, {'points':[{'id':str(i),'location':locations[i],'residents':100,'jobs':100,'popIds':[f'local-{i}']}],
                     'pops':[{'id':f'local-{i}','size':100,'residenceId':str(i),'jobId':str(i),'drivingSeconds':60,'drivingDistance':100}]})
        write(path.parent/'manifest.json', {'tileId':tile,'sha256':sha256(path)})
    write(demand/'world/cross_demand.json.gz', {
        'pointFields':['id','longitude','latitude','tileId','residents','workers'],
        'popFields':['id','mass','homePoint','workPoint','drivingSeconds','drivingDistance','tripType'],
        'points':[['0',*locations[0],tiles[0],cross_mass,0],['1',*locations[1],tiles[1],0,cross_mass]],
        'pops':[['cross',cross_mass,0,1,100,1000],['one-way',20,1,0,100,1000,'oneWay']]})
    write(demand/'world/cross_commutes.json', {'buckets':[{'mass':cross_mass},{'mass':20,'tripType':'oneWay'}]})
    write(demand/'reports/japan-national-demand.json', {
        'compilerVersion':'estat-japan-national-package-v8-road-voronoi',
        'acceptedMass':200+cross_mass,'ownershipBoundary':{'sha256':sha256(boundary)},
        'voronoiMerging':{'minimumPositiveDemand':50,'minimumSpacingM':275}})
    return world, demand


class RoadVoronoiVerificationTests(unittest.TestCase):
    def test_one_way_movements_preserve_commute_totals_and_do_not_create_small_home_job_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            report = verify(*fixture(Path(directory)))
        self.assertEqual(report['oneWayMass'],20)
        self.assertEqual(report['totalMass'],270)
        self.assertGreaterEqual(report['minimumCanonicalSpacingM'],275)

    def test_sub_50_cross_weights_are_rejected_even_with_large_native_weights_at_same_site(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,'below the minimum'):
                verify(*fixture(Path(directory),cross_mass=49))

    def test_close_points_across_prefecture_borders_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,'minimum spacing'):
                verify(*fixture(Path(directory),close=True))
