import copy
import unittest
import numpy as np
from shapely.geometry import box,GeometryCollection
from pyproj import Transformer
from open_world_map_creator.demand.frontage_allocation import road_weights,allocate_integer,select_sites,assign_cells,refine_buildings

class PlacementTests(unittest.TestCase):
    def test_road_semantics_exclude_nonfrontage_infrastructure(self):
        for tags in ({'highway':'motorway'},{'highway':'track'},{'highway':'residential','bridge':'yes'},
                     {'highway':'primary','tunnel':'yes'},{'highway':'service','service':'parking_aisle'}):
            self.assertIsNone(road_weights(tags))
        self.assertIsNotNone(road_weights({'highway':'residential'}))
        self.assertIsNotNone(road_weights({'highway':'service','service':'driveway'}))

    def test_integer_allocation_conserves_small_and_large_marginals(self):
        for mass in (1,5,100,3999295):
            result=allocate_integer([1,3,2,5],mass)
            self.assertEqual(sum(result),mass)
        with self.assertRaises(ValueError):allocate_integer([0,0],100)

    def test_one_mesh_cell_splits_across_road_frontage_and_is_conserved(self):
        forward=Transformer.from_crs('EPSG:4326','+proj=aeqd +lat_0=36 +lon_0=139 +datum=WGS84 +units=m',always_xy=True)
        sites=[dict(id=str(i),xy=[x,0],anchor='road-frontage') for i,x in enumerate((-100,0,100))]
        samples=[dict(**s,length=50,weights=[1,1]) for s in sites]
        cells=[dict(id='mesh-1',longitude=139,latitude=36,commuters=300)]
        weights,report,contributions=assign_cells(sites,samples,cells,'commuters',forward,box(-500,-500,500,500),GeometryCollection())
        self.assertEqual(list(weights),[100,100,100])
        self.assertEqual(report['splitCells'],1)
        self.assertEqual(sum(n for _,n in contributions[0][2]),300)

    def test_missing_buildings_do_not_change_sites_or_weights(self):
        baseline=[dict(id='a',xy=[0,0],home=100),dict(id='b',xy=[200,0],home=200)]
        complete=copy.deepcopy(baseline);missing=copy.deepcopy(baseline)
        refine_buildings(complete,np.array([[10,10],[205,5]]),box(-100,-100,400,100),GeometryCollection())
        refine_buildings(missing,np.empty((0,2)),box(-100,-100,400,100),GeometryCollection())
        self.assertEqual([s['home'] for s in complete],[s['home'] for s in missing])
        self.assertEqual(len(complete),len(missing))
        self.assertTrue(all(np.linalg.norm(np.array(a['xy'])-b['xy'])<=30 for a,b in zip(complete,missing)))

    def test_refinement_respects_water_and_owner(self):
        sites=[dict(id='a',xy=[0,0])]
        self.assertEqual(refine_buildings(sites,np.array([[5,5]]),box(-20,-20,20,20),box(4,4,6,6)),0)
        self.assertEqual(refine_buildings(sites,np.array([[5,5]]),box(-20,-20,2,2),GeometryCollection()),0)

    def test_sampling_is_deterministic_and_has_no_mesh_anchor_requirement(self):
        samples=[dict(id=f'road/{i}',xy=[i*50,12],length=50,weights=[1,1]) for i in range(30)]
        first=select_sites(samples,np.array([[500,0],[1000,0]]),[100,200])
        second=select_sites(list(reversed(samples)),np.array([[500,0],[1000,0]]),[100,200])
        self.assertEqual([s['id'] for s in first],[s['id'] for s in second])
        for i,a in enumerate(first):
            for b in first[i+1:]:self.assertGreaterEqual(np.linalg.norm(np.array(a['xy'])-b['xy']),max(a['radius'],b['radius']))

if __name__=='__main__':unittest.main()
