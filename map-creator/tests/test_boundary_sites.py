import gzip
import json
import struct
import tempfile
import unittest
import io
from contextlib import redirect_stdout
from pathlib import Path

from shapely.geometry import box, Point, mapping

from open_world_map_creator.demand.building_sites import BINARY_MAGIC, HEADER_SIZE
from open_world_map_creator.demand.boundary_sites import compile_boundary_sites
from open_world_map_creator.demand.owned_ledger import OwnedDemandLedger
from open_world_map_creator.demand.package_japan import Site, CrossRecord, road_estimate, _local_records, compile_japan, tile_id
from open_world_map_creator.demand.verify_japan import verify


def building_index(path, centers):
    header = bytearray(HEADER_SIZE)
    struct.pack_into('<I', header, 0, BINARY_MAGIC)
    header[4] = 1
    struct.pack_into('<I', header, 8, len(centers))
    struct.pack_into('<d', header, 40, .0009)
    with gzip.open(path, 'wb') as stream:
        stream.write(header)
        for x, y in centers:
            stream.write(struct.pack('<4d', x-.00001, y-.00001, x+.00001, y+.00001))


class BoundarySiteTests(unittest.TestCase):
    def test_national_package_and_independent_verifier_agree_on_final_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            world=root/'world'
            (world/'geography').mkdir(parents=True)
            codes=[f'{i:02}' for i in range(1,48)]
            polygons={code:box(135+i*.03,34,135+i*.03+.02,34.02) for i,code in enumerate(codes)}
            def write(path,value):
                path.parent.mkdir(parents=True,exist_ok=True)
                path.write_text(json.dumps(value))
            write(world/'world.json',{'tileViews':{'ownershipBoundary':'geography/prefectures.geojson'}})
            write(world/'geography/prefectures.geojson',{'type':'FeatureCollection','features':[
                {'type':'Feature','properties':{'pref_code':code},'geometry':mapping(polygon)} for code,polygon in polygons.items()]})
            write(world/'geography/tile-views.json',{'worldId':'test','tiles':[
                {'id':tile_id(code),'prefCode':code,'status':'selected','initialView':{'longitude':135,'latitude':34}} for code in codes]})
            write(world/'demand.json',{'cohortPolicy':{}})
            shared={'home':[],'jobs':[],'flows':[]}
            for i,code in enumerate(codes):
                owner='27' if code=='28' else code
                x,y=polygons[owner].centroid.coords[0]
                home={'type':'Feature','geometry':{'type':'Point','coordinates':[x,y]},'properties':{'prefCode':code,'commuters':10}}
                job={**home,'properties':{'prefCode':code,'jobs':10}}
                flows=[{'originMunicipalityCode':code+'001','destinationMunicipalityCode':dest+'001','commutersAndStudents':10}
                       for dest in [code,codes[(i+1)%47]]]
                if code in ('13','14'):
                    shared['home'].append(home); shared['jobs'].append(job); shared['flows'].extend(flows)
                else:
                    directory=root/'evidence'/tile_id(code)
                    write(directory/'home-mesh-250m.geojson',{'features':[home]})
                    write(directory/'job-mesh-500m.geojson',{'features':[job]})
                    write(directory/'municipality-od.json',{'flows':flows})
                path=root/'maps'/tile_id(code)/'buildings_index.bin.gz'
                path.parent.mkdir(parents=True)
                building_index(path,[polygons[code].centroid.coords[0]])
            write(root/'shared/home-mesh-250m.geojson',{'features':shared['home']})
            write(root/'shared/job-mesh-500m.geojson',{'features':shared['jobs']})
            write(root/'shared/municipality-od.json',{'flows':shared['flows']})
            with redirect_stdout(io.StringIO()):
                compile_japan(world_root=world,evidence_root=root/'evidence',compatible_evidence=root/'shared',
                              maps_root=root/'maps',output_root=root/'output')
            result=verify(world,root/'output')
            self.assertEqual(result['totalMass'],940)
            self.assertEqual(result['crossOutsideRenderedBoundaryPointCount'],0)
            for code in codes:
                with gzip.open(root/'output/tiles'/tile_id(code)/'demand_data.json.gz','rt') as stream:
                    self.assertTrue(all(p['id'].startswith('jp-national-local-') for p in json.load(stream)['pops']))
            with gzip.open(root/'output/world/cross_demand.json.gz','rt') as stream:
                cross=json.load(stream)
            self.assertTrue(all(p[0].startswith('jp-national-cross-') for p in cross['pops']))

    def test_final_owners_classify_native_and_cross_without_recovery_flags(self):
        home = Site('home',135,34,10,0,'28','27')
        work = Site('work',135.001,34.001,0,10,'26','27')
        other = Site('other',135.002,34.002,0,10,'28','28')
        ledger = OwnedDemandLedger(['26','27','28'],road_estimate)
        ledger.add(CrossRecord('native',10,home,work,'28','26'))
        ledger.add(CrossRecord('cross',5,home,other,'28','28'))
        native,reports,cross = ledger.finish()
        self.assertEqual([p['id'] for p in native['27']['pops']],['native'])
        self.assertEqual([p.id for p in cross],['cross'])
        self.assertEqual(sum(r['nativeMass'] for r in reports.values())+sum(p.mass for p in cross),15)
        self.assertEqual(native['28']['points'],[])

    def test_local_od_allocation_conserves_mass_before_owner_classification(self):
        sites=[Site('a',135,34,5,0,'27','27'),Site('b',135.01,34.01,0,5,'27','28')]
        records=list(_local_records('27',sites,501))
        self.assertEqual(sum(r.mass for r in records),501)
        self.assertTrue(all(r.home.owner_pref=='27' and r.work.owner_pref=='28' for r in records))

    def test_source_labels_do_not_choose_owner_or_create_an_edge_grid(self):
        boundaries = {'27': box(135, 34, 135.02, 34.02), '28': box(134.98, 34, 135, 34.02)}
        cells = [{'longitude': 135.001+i*.0002, 'latitude': 34.01, 'commuters': 10} for i in range(10)]
        sources = {'28': {'home': cells, 'jobs': [{'longitude': 135.001, 'latitude': 34.01, 'jobs': 80}]}}
        with tempfile.TemporaryDirectory() as directory:
            paths = {code: Path(directory)/f'{code}.gz' for code in boundaries}
            building_index(paths['27'], [(135.0011,34.0101),(135.0028,34.0099)])
            building_index(paths['28'], [(134.9999,34.01)])
            sites, report = compile_boundary_sites(boundaries, sources, paths, {}, lambda *_: None)
        self.assertEqual(sum(s['home_weight'] for s in sites['28']), 100)
        self.assertEqual(sum(s['job_weight'] for s in sites['28']), 80)
        self.assertLess(len(sites['28']), len(cells))
        self.assertTrue(all(s['owner_pref']=='27' and not s['force_cross'] for s in sites['28']))
        self.assertTrue(all(boundaries['27'].covers(Point(s['longitude'],s['latitude'])) for s in sites['28']))
        self.assertEqual(report['unanchoredSiteCount'], 0)

    def test_coastal_overhang_is_clipped_before_owner_building_selection(self):
        boundary = box(135,34,135.02,34.02)
        cells = {'27': {'home':[{'longitude':135.02005,'latitude':34.01,'commuters':10}], 'jobs':[]}}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'buildings.gz'
            # The closest building is outside the authoritative tile.
            building_index(path,[(135.02006,34.01),(135.019,34.0101)])
            sites, report=compile_boundary_sites({'27':boundary},cells,{'27':path},{},lambda *_:None)
        self.assertEqual(len(sites['27']),1)
        site=sites['27'][0]
        self.assertEqual((site['longitude'],site['latitude']),(135.019,34.0101))
        self.assertFalse(site['force_cross'])
        self.assertEqual(report['coastalAdjustedCellCount'],1)

    def test_distant_or_unanchorable_evidence_fails_instead_of_emitting_grid_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'buildings.gz'
            building_index(path,[(135.01,34.01)])
            with self.assertRaisesRegex(ValueError,'outside.*ownership'):
                compile_boundary_sites({'27':box(135,34,135.02,34.02)},
                    {'27':{'home':[{'longitude':136,'latitude':35,'commuters':10}],'jobs':[]}},
                    {'27':path},{},lambda *_:None)

    def test_no_building_fallback_and_no_serialization_escape(self):
        boundary=box(135,34,135.02000004,34.02)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'buildings.gz'
            building_index(path,[(135.020000039,34.01)])
            sources={'27':{'home':[{'longitude':135.0199,'latitude':34.01,'commuters':5}],'jobs':[]}}
            sites,_=compile_boundary_sites({'27':boundary},sources,{'27':path},{},lambda *_:None)
            self.assertTrue(boundary.covers(Point(sites['27'][0]['longitude'],sites['27'][0]['latitude'])))
            building_index(path,[(135.0201,34.01)])
            with self.assertRaisesRegex(ValueError,'no .*building'):
                compile_boundary_sites({'27':boundary},sources,{'27':path},{},lambda *_:None)
            # An unrounded centre is inside, but its seven-decimal output is not.
            boundary=box(135.00000004,34,135.02,34.02)
            sources['27']['home'][0]['longitude']=135.0001
            building_index(path,[(135.000000041,34.01),(135.001,34.01)])
            sites,_=compile_boundary_sites({'27':boundary},sources,{'27':path},{},lambda *_:None)
            self.assertEqual(sites['27'][0]['longitude'],135.001)
