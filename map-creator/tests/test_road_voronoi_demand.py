import gzip
import struct
import tempfile
import unittest
from pathlib import Path

from shapely.geometry import box, Point, mapping

from open_world_map_creator.demand.building_sites import BINARY_MAGIC, HEADER_SIZE
from open_world_map_creator.demand.boundary_sites import compile_boundary_sites
from open_world_map_creator.demand.merge_owned_demand import merge_owned_demand
from open_world_map_creator.demand.owned_ledger import OwnedDemandLedger
from open_world_map_creator.demand.package_japan import Site, CrossRecord, road_estimate
from open_world_map_creator.demand.physical_land import PhysicalLandIndex


def empty_buildings(path):
    header=bytearray(HEADER_SIZE)
    struct.pack_into('<I',header,0,BINARY_MAGIC);header[4]=1
    struct.pack_into('<d',header,40,.0009)
    with gzip.open(path,'wb') as output:output.write(header)


class Roads:
    def owner_pin(self,owner):return {'fixture':'roads-v1'}
    def owner_data(self,owner,boundary):
        return dict(roads=[dict(id='osm-road-1',coordinates=[[135.001,34.005],[135.019,34.005]],
                                weights=[1,1],highway='residential')],masks=[],landuse=[])


class RoadVoronoiDemandTests(unittest.TestCase):
    def test_missing_buildings_use_frontage_with_shared_owner_and_exact_source_masses(self):
        boundaries={'27':box(135,34,135.02,34.02),'28':box(134.98,34,135,34.02)}
        sources={code:{'home':[dict(longitude=135.010,latitude=34.005,commuters=n)],
                       'jobs':[dict(longitude=135.010,latitude=34.005,jobs=n//2)]} for code,n in [('27',200),('28',400)]}
        land=PhysicalLandIndex({'purpose':'physical-land-computation','features':[{'geometry':mapping(boundaries['27'])}]})
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'buildings.gz';empty_buildings(path)
            rows,report=compile_boundary_sites(boundaries,sources,{'27':path,'28':path},
                {'sitePlacement':'road-frontage-v1'},lambda *_:None,road_support=Roads(),physical_land=land)
        for source,total in [('27',200),('28',400)]:
            self.assertEqual(sum(r['home_weight'] for r in rows[source]),total)
            self.assertEqual(sum(r['job_weight'] for r in rows[source]),total//2)
            self.assertTrue(all(r['owner_pref']=='27' and land.covers([[r['longitude'],r['latitude']]])[0] for r in rows[source]))
        self.assertTrue(set(r['id'] for r in rows['27']) & set(r['id'] for r in rows['28']))
        self.assertGreater(report['owners']['27']['roadSamples'],0)

    def test_native_cross_merging_preserves_every_cohort_and_mode(self):
        bounds={'27':box(135,34,135.02,34.02),'28':box(136,34,136.02,34.02)}
        a=Site('a',135.005,34.005,1,1,'27','27');b=Site('b',135.006,34.005,1,1,'27','27')
        c=Site('c',136.005,34.005,1,1,'28','28');d=Site('d',136.006,34.005,1,1,'28','28')
        ledger=OwnedDemandLedger(bounds,road_estimate)
        ledger.add(CrossRecord('local',80,a,b,'27','27'))
        ledger.add(CrossRecord('cross-1',20,a,c,'27','28'))
        ledger.add(CrossRecord('cross-2',30,b,d,'27','28'))
        native,_,cross=ledger.finish()
        result,remapped,report=merge_owned_demand(native,cross,bounds,progress=lambda *_:None)
        self.assertEqual(len(result['27']['points']),1)
        self.assertEqual(result['27']['points'][0]['residents'],80)
        self.assertEqual(result['27']['points'][0]['jobs'],80)
        self.assertEqual(result['27']['points'][0]['popIds'],['local'])
        self.assertEqual([(p.id,p.mass,p.source_origin_pref,p.source_destination_pref) for p in remapped],
                         [(p.id,p.mass,p.source_origin_pref,p.source_destination_pref) for p in cross])
        for record in remapped:
            self.assertEqual(record.home.owner_pref,'27');self.assertEqual(record.work.owner_pref,'28')
        for row in report['owners'].values():self.assertEqual(row['totalsBefore'],row['totalsAfter'])

    def test_border_spacing_is_repaired_without_changing_owners(self):
        bounds={'27':box(135,34,135.01,34.02),'28':box(135.01,34,135.03,34.02)}
        ledger=OwnedDemandLedger(bounds,road_estimate)
        for name,x,owner,mass in [('a',135.001,'27',200),('b',135.009,'27',100),('c',135.011,'28',100),('d',135.024,'28',200)]:
            site=Site(name,x,34.005,1,1,owner,owner)
            ledger.add(CrossRecord(name,mass,site,site,owner,owner))
        native,_,cross=ledger.finish()
        result,_,report=merge_owned_demand(native,cross,bounds,progress=lambda *_:None)
        self.assertGreater(report['borderRepairRounds'],0)
        self.assertGreaterEqual(report['measuredMinimumSpacingM'],275)
        for owner,payload in result.items():
            self.assertEqual(sum(p['size'] for p in payload['pops']),300)
            self.assertTrue(all(bounds[owner].covers(Point(p['location'])) for p in payload['points']))

    def test_sparse_cross_view_merges_do_not_collapse_unrelated_native_demand(self):
        bounds={'27':box(135,34,135.04,34.02),'28':box(136,34,136.02,34.02)}
        sites=[Site(name,x,34.005,1,1,'27','27') for name,x in [('a',135.005),('b',135.010),('c',135.015)]]
        destination=Site('d',136.005,34.005,1,1,'28','28')
        ledger=OwnedDemandLedger(bounds,road_estimate)
        for site in sites+[destination]:
            ledger.add(CrossRecord(f'local-{site.id}',100,site,site,site.owner_pref,site.owner_pref))
        ledger.add(CrossRecord('rare-cross-a',20,sites[0],destination,'27','28'))
        ledger.add(CrossRecord('rare-cross-c',30,sites[2],destination,'27','28'))
        native,_,cross=ledger.finish()
        result,remapped,report=merge_owned_demand(native,cross,bounds,progress=lambda *_:None)
        self.assertEqual(len(result['27']['points']),3,'Sparse cross-view weights must not absorb ordinary native neighborhoods')
        self.assertEqual([p['residents'] for p in result['27']['points']],[100,100,100])
        self.assertEqual(len({record.home.id for record in remapped}),1)
        self.assertEqual(sum(record.mass for record in remapped),50)
        self.assertTrue({record.home.id for record in remapped} <= {p['id'] for p in result['27']['points']})
        self.assertGreaterEqual(report['measuredMinimumSpacingM'],275)

    def test_road_placement_requires_explicit_cached_support(self):
        with self.assertRaisesRegex(ValueError,'cached OSM'):
            compile_boundary_sites({'27':box(135,34,136,35)},
                {'27':{'home':[dict(longitude=135.5,latitude=34.5,commuters=100)]}}, {},
                {'sitePlacement':'road-frontage-v1'},lambda *_:None)

    def test_native_endpoint_floor_does_not_move_the_other_endpoint_type(self):
        bounds={'27':box(135,34,135.04,34.02)}
        sites=[Site(name,x,34.005,1,1,'27','27') for name,x in [('a',135.005),('b',135.010),('c',135.015)]]
        for reverse in (False,True):
            with self.subTest(reverse=reverse):
                ledger=OwnedDemandLedger(bounds,road_estimate)
                pairs=[(sites[0],sites[0],2),(sites[0],sites[2],198),
                       (sites[1],sites[2],200),(sites[2],sites[2],200)]
                for i,(home,work,mass) in enumerate(pairs):
                    if reverse:home,work=work,home
                    ledger.add(CrossRecord(str(i),mass,home,work,'27','27'))
                native,_,cross=ledger.finish()
                result,_,report=merge_owned_demand(native,cross,bounds,progress=lambda *_:None)
                points=result['27']['points']
                preserved='jobs' if reverse else 'residents'
                merged='residents' if reverse else 'jobs'
                self.assertEqual(sorted(p[preserved] for p in points if p[preserved]),[200,200,200])
                self.assertEqual([p[merged] for p in points if p[merged]],[600])
                self.assertEqual([(p['id'],p['size']) for p in result['27']['pops']],
                                 [(p['id'],p['size']) for p in native['27']['pops']])
                self.assertGreaterEqual(report['measuredMinimumSpacingM'],275)

    def test_cross_endpoint_floor_does_not_move_the_other_endpoint_type(self):
        bounds={'27':box(135,34,135.04,34.02),'28':box(136,34,136.02,34.02)}
        sites=[Site(name,x,34.005,1,1,'27','27') for name,x in [('a',135.005),('b',135.010),('c',135.015)]]
        other=Site('d',136.005,34.005,1,1,'28','28')
        for reverse in (False,True):
            with self.subTest(reverse=reverse):
                ledger=OwnedDemandLedger(bounds,road_estimate)
                for site in sites+[other]:
                    ledger.add(CrossRecord(f'local-{site.id}',100,site,site,site.owner_pref,site.owner_pref))
                pairs=[(site,other,200) for site in sites]+[(other,sites[0],2),(other,sites[2],198)]
                for i,(home,work,mass) in enumerate(pairs):
                    if reverse:home,work=work,home
                    ledger.add(CrossRecord(f'cross-{i}',mass,home,work,home.owner_pref,work.owner_pref))
                native,_,cross=ledger.finish()
                result,remapped,report=merge_owned_demand(native,cross,bounds,progress=lambda *_:None)
                weights={}
                for record in remapped:
                    endpoint=record.work if reverse else record.home
                    if endpoint.owner_pref=='27':weights[endpoint.id]=weights.get(endpoint.id,0)+record.mass
                self.assertEqual(sorted(weights.values()),[200,200,200])
                tiny_endpoints={getattr(r,'home' if reverse else 'work').id for r in remapped
                                if getattr(r,'home' if reverse else 'work').owner_pref=='27'}
                self.assertEqual(len(tiny_endpoints),1)
                self.assertEqual(len(result['27']['points']),3)
                self.assertEqual(sum(r.mass for r in remapped),800)
                self.assertGreaterEqual(report['measuredMinimumSpacingM'],275)


if __name__=='__main__':unittest.main()
