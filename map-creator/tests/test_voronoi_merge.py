import unittest
import numpy as np
from scipy.spatial import cKDTree
from open_world_map_creator.demand.voronoi_merge import merge_cells, remap_native


class VoronoiMergeTests(unittest.TestCase):
    def test_floor_applies_to_each_positive_mode_after_native_scaling(self):
        xy=np.array([[0,0],[400,0],[800,0],[1200,0]],float)
        mass=np.array([[20,100],[30,100],[100,0],[0,100]])
        result=merge_cells(xy,mass,min_weight=50,min_spacing=250)
        final=np.array([c['mass'] for c in result['cells']])
        self.assertTrue(np.all((final==0)|(final>=50)))
        np.testing.assert_array_equal(final.sum(axis=0),mass.sum(axis=0))
        self.assertEqual(len(result['cells']),3)

    def test_close_chain_does_not_collapse_as_a_connected_component(self):
        xy=np.array([[x,0] for x in range(0,2001,100)],float)
        mass=np.full((len(xy),2),100)
        result=merge_cells(xy,mass,min_spacing=250)
        anchors=xy[[c['anchor'] for c in result['cells']]]
        self.assertGreaterEqual(len(anchors),4)
        self.assertGreaterEqual(cKDTree(anchors).query(anchors,k=2)[0][:,1].min(),250)

    def test_final_anchor_is_an_original_valid_location_and_runs_repeatably(self):
        xy=np.array([[0,0],[80,40],[300,0],[300,400],[0,400]],float)
        mass=np.array([[100,70],[3,4],[100,100],[100,100],[100,100]])
        a=merge_cells(xy,mass,min_spacing=250)
        b=merge_cells(xy,mass,min_spacing=250)
        self.assertEqual(a,b)
        self.assertEqual(sorted(i for c in a['cells'] for i in c['members']),list(range(len(xy))))
        for c in a['cells']:self.assertIn(c['anchor'],c['members'])

    def test_cohorts_and_point_totals_survive_endpoint_remapping(self):
        native={'points':[
            dict(id='a',location=[139,36],residents=20,jobs=30,popIds=['p','q']),
            dict(id='b',location=[139.001,36],residents=30,jobs=20,popIds=['p','q'])],
            'pops':[dict(id='p',size=20,residenceId='a',jobId='b',drivingPath=[[1,2],[3,4]],drivingSeconds=1),
                    dict(id='q',size=30,residenceId='b',jobId='a',drivingDistance=1)]}
        result=merge_cells(np.array([[0,0],[90,0]]),np.array([[20,30],[30,20]]))
        final,mapping=remap_native(native,result)
        self.assertEqual(len(final['points']),1)
        p=final['points'][0]
        self.assertEqual((p['residents'],p['jobs']),(50,50))
        self.assertEqual(p['popIds'],['p','q'])
        self.assertEqual(sum(x['size'] for x in final['pops']),50)
        for pop in final['pops']:
            self.assertEqual(pop['residenceId'],p['id']);self.assertEqual(pop['jobId'],p['id'])
            self.assertFalse(any(k.startswith('driving') for k in pop))
        self.assertEqual(set(mapping),{'a','b'})

    def test_duplicate_and_collinear_sites_are_supported(self):
        xy=np.array([[0,0],[0,0],[100,0],[500,0],[1000,0]],float)
        result=merge_cells(xy,np.full((5,2),50),min_spacing=250)
        self.assertEqual(sum(len(c['members']) for c in result['cells']),5)
        anchors=xy[[c['anchor'] for c in result['cells']]]
        self.assertGreaterEqual(cKDTree(anchors).query(anchors,k=2)[0][:,1].min(),250)

    def test_waits_for_a_busy_local_neighbor_instead_of_a_distant_hull_edge(self):
        xy=np.array([[0,0],[1,0],[2,0],[10000,0]],float)
        result=merge_cells(xy,np.array([[1,1],[100,100],[1,1],[100,100]]),min_spacing=.1)
        self.assertEqual([c['members'] for c in result['cells']],[[0,1,2],[3]])

    def test_valid_distribution_is_unchanged_and_impossible_floor_fails(self):
        xy=np.array([[0,0],[500,0],[0,500]])
        result=merge_cells(xy,np.array([[50,0],[100,50],[0,100]]),min_spacing=250)
        self.assertEqual([c['members'] for c in result['cells']],[[0],[1],[2]])
        with self.assertRaisesRegex(ValueError,'total'):
            merge_cells(xy,np.array([[1,100],[2,100],[3,100]]))


if __name__=='__main__':unittest.main()
