import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import shapely
from shapely.geometry import Polygon, MultiPolygon, box, mapping, shape
from open_world_map_creator.geography import computation_boundary, ownership_boundary, display_lods, unowned_boundary_holes
from open_world_map_creator.demand.estat_japan_prefecture import load_prefecture_boundary
from open_world_map_creator.routing.prepare_water_land import repair_area_rings
from open_world_map_creator.routing.repair_water_sources import polygonize_ways


class GeometryTests(unittest.TestCase):
    def test_interior_water_holes_are_not_confused_with_neighboring_enclaves(self):
        enclave=box(1,1,2,2)
        surrounding=box(0,0,3,3).difference(enclave)
        self.assertEqual(sum(g.area for g in unowned_boundary_holes([surrounding])),1)
        self.assertEqual(unowned_boundary_holes([surrounding,enclave]),[])

    def test_small_islands_are_full_detail_only_without_mutating_ownership(self):
        source = {'type':'FeatureCollection','features':[{'type':'Feature','properties':{'pref_code':'27'},
            'geometry':mapping(MultiPolygon([box(135,34,135.1,34.1),box(135.15,34,135.1501,34.0001)]))}]}
        original=json.dumps(source)
        result=display_lods(source,lambda _:None)
        coarse=shape(result['lods'][0]['features'][0]['geometry'])
        detailed=shape(result['lods'][-1]['features'][0]['geometry'])
        self.assertEqual(len(shapely.get_parts(coarse)),1)
        self.assertEqual(len(shapely.get_parts(detailed)),2)
        self.assertEqual(json.dumps(source),original)

    def test_display_island_filter_keeps_shared_border_components(self):
        features=[]
        for code, mainland, island in [('27',box(135,34,135.1,34.1),box(135.15,34,135.16,34.001)),
                                        ('28',box(135.2,34,135.3,34.1),box(135.16,34,135.17,34.001))]:
            features.append({'type':'Feature','properties':{'pref_code':code},
                'geometry':mapping(MultiPolygon([mainland,island]))})
        coarse=display_lods({'type':'FeatureCollection','features':features},lambda _:None)['lods'][0]
        self.assertEqual(coarse['hiddenSmallIslandCount'],0)
        self.assertTrue(all(len(shapely.get_parts(shape(f['geometry'])))==2 for f in coarse['features']))

    def test_explicit_ownership_is_independent_of_raw_geometry_and_display_lods(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            definition = {"map": {"computationBoundary": "missing-raw.geojson"},
                          "tileViews": {"ownershipBoundary": "approved.geojson", "boundaryOverlay": "display.json"}}
            (root / "world.json").write_text(json.dumps(definition))
            with self.assertRaises(FileNotFoundError):
                ownership_boundary(root)
            approved = root / "approved.geojson"
            approved.write_text(json.dumps({"type": "FeatureCollection", "features": []}))
            self.assertEqual(ownership_boundary(root), approved)
            definition['tileViews']['ownershipBoundary'] = '../escape.json'
            (root / "world.json").write_text(json.dumps(definition))
            with self.assertRaisesRegex(ValueError, 'escapes'):
                ownership_boundary(root)
            approved.write_text(json.dumps({"purpose": "display-only", "features": []}))
            with self.assertRaisesRegex(ValueError, 'Display LODs'):
                load_prefecture_boundary(set(), approved)

    def test_reconstructs_self_intersecting_water_and_fragmented_outer_rings(self):
        bowtie = polygonize_ways([[(0, 0), (2, 2), (0, 2), (2, 0), (0, 0)]])
        self.assertTrue(bowtie.is_valid)
        self.assertEqual(bowtie.area, 2)
        fragmented = polygonize_ways([[(0, 0), (2, 0)], [(2, 0), (2, 2)],
                                      [(2, 2), (0, 2)], [(0, 2), (0, 0)]])
        self.assertEqual(fragmented.area, 4)

    def test_repairs_invalid_osm_water_ring_without_filling_holes(self):
        def ring(points):
            return [SimpleNamespace(location=SimpleNamespace(lon=x, lat=y)) for x, y in points]
        outer = ring([(0, 0), (4, 0), (4, 4), (0, 4), (0, 0)])
        inner = ring([(1, 1), (2, 1), (2, 2), (1, 2), (1, 1)])
        area = SimpleNamespace(outer_rings=lambda: [outer], inner_rings=lambda _: [inner])
        repaired = repair_area_rings(area)
        self.assertTrue(repaired.is_valid)
        self.assertEqual(repaired.area, 15)
        self.assertEqual(len(repaired.interiors), 1)

    def test_lods_share_seams_and_do_not_mutate_computation_input(self):
        seam = [(140 + .001 * (i % 2), 35 + i * .001) for i in range(51)]
        polygons = [Polygon([(139.9, 35), *seam, (139.9, 35.05)]),
                    Polygon([*reversed(seam), (140.1, 35), (140.1, 35.05)])]
        source = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"pref_code": str(i)}, "geometry": mapping(g)}
            for i, g in enumerate(polygons)]}
        original = json.dumps(source)
        result = display_lods(source, lambda _: None)
        self.assertEqual([level["minZoom"] for level in result["lods"]], [0, 7, 9, 11, 13])
        self.assertEqual(json.dumps(source), original)
        self.assertLess(result["lods"][0]["vertexCount"], result["lods"][-1]["vertexCount"])
        for level in result["lods"]:
            left, right = [shape(f["geometry"]) for f in level["features"]]
            self.assertLess(left.intersection(right).area, 1e-12)
            self.assertGreater(left.boundary.intersection(right.boundary).length, .04)

    def test_computation_never_falls_back_to_display_when_declared_source_missing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "world.json").write_text(json.dumps({"map": {"computationBoundary": "japan/full.geojson"}}))
            with self.assertRaisesRegex(FileNotFoundError, "do not substitute display"):
                computation_boundary(root, root / "sources")
            target = root / "sources/japan/full.geojson"
            target.parent.mkdir(parents=True)
            target.write_text("{}")
            self.assertEqual(computation_boundary(root, root / "sources"), target)
