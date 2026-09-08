import unittest
from collections import Counter
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import numpy as np
from shapely.geometry import Polygon, MultiPolygon, box
from shapely.geometry import mapping
from open_world_map_creator.maps.building_boundary import ownership_mask, verified_publication
from open_world_map_creator.maps.building_boundary import VERSION, digest, encode_index, decode_index, filter_index, filter_vector_tile, update_nonbuilding_digest, publish_package, filter_pmtiles


def fixture(flags=3):
    buildings = [box(0, 0, 1, 1), box(2, 0, 3, 1), box(4, 0, 5, 1)]
    header = dict(magic=0x49424253, version=1, flags=flags, reserved=0,
                  buildings=3, cols=5, rows=1, rings=3, coords=15, cells=3, refs=4,
                  osmIds=4 if flags & 2 else 0, cellSize=1, maxDepth=30,
                  minLon=0, minLat=0, maxLon=5, maxLat=1)
    arrays = dict(bounds=np.array([b.bounds for b in buildings]).reshape(-1),
                  depths=[10, 20, 30], buildingRings=[0, 1, 2, 3], ringCoords=[0, 5, 10, 15],
                  coords=np.array([list(b.exterior.coords) for b in buildings]).reshape(-1),
                  rowStarts=[0, 3], cellCols=[0, 2, 4], cellOffsets=[0, 1, 3, 4],
                  cellIds=[0, 1, 2, 2], heights=[11, 22, 33], osmOffsets=[0, 1, 3, 4],
                  osmIds=[101, 202, 203, 304])
    return encode_index(header, arrays)


class BuildingBoundaryTests(unittest.TestCase):
    def test_preserves_exclaves_and_exact_geometry_and_remaps_cells(self):
        original = fixture()
        output, report = filter_index(original, MultiPolygon([box(-1, -1, 1.1, 2), box(4.5, -1, 6, 2)]), lambda *a, **k: None)
        h, a = decode_index(output)
        self.assertEqual(report['retainedBuildings'], 2)
        self.assertLess(len(output), len(original))
        self.assertEqual(h['cols'], 5)
        self.assertEqual(a['cellIds'].tolist(), [0, 1, 1])
        self.assertEqual(a['cellOffsets'].tolist(), [0, 1, 2, 3])
        self.assertEqual(a['osmIds'].tolist(), [101, 304])
        self.assertEqual(a['heights'].tolist(), [11, 33])
        self.assertEqual(a['depths'].tolist(), [10, 30])
        _, source = decode_index(original)
        np.testing.assert_array_equal(a['coords'], np.concatenate([source['coords'][:10], source['coords'][20:]]))

    def test_holes_exclude_buildings_and_legacy_flags_are_preserved(self):
        mask = Polygon([(-1, -1), (6, -1), (6, 2), (-1, 2)], [[(1.5, -.5), (3.5, -.5), (3.5, 1.5), (1.5, 1.5)]])
        output, _ = filter_index(fixture(0), mask, lambda *a, **k: None)
        h, a = decode_index(output)
        self.assertEqual(h['buildings'], 2)
        self.assertNotIn('heights', a)
        self.assertNotIn('osmIds', a)

    def test_refuses_empty_mask_result_and_unknown_binary_flags(self):
        with self.assertRaisesRegex(ValueError, 'no buildings'):
            filter_index(fixture(), box(10, 10, 11, 11), lambda *a, **k: None)
        invalid = bytearray(fixture()); invalid[5] = 4
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            decode_index(invalid)

    def test_render_filter_keeps_crossing_buildings_and_preserves_other_layers(self):
        from mapbox_vector_tile import encode, decode
        layers = [dict(name='buildings', features=[
            dict(geometry=box(500, 500, 1000, 1000), properties={'height': 12}, id=1),
            dict(geometry=box(1500, 500, 2000, 1000), properties={'height': 20}, id=2),
            dict(geometry=box(3000, 3000, 3500, 3500), properties={'height': 30}, id=3),
        ]), dict(name='city_labels', features=[dict(geometry=box(10, 10, 20, 20).centroid, properties={'name': 'Tokyo'})])]
        raw = encode(layers, default_options={'y_coord_down': True})
        counts = Counter()
        result = filter_vector_tile(raw, (0, 0, 0), box(.1, .1, .4, .4), counts)
        decoded = decode(result, default_options={'y_coord_down': True})
        self.assertEqual([f['id'] for f in decoded['buildings']['features']], [1, 2])
        self.assertEqual(counts['removedFeatures'], 1)
        before, after = hashlib.sha256(), hashlib.sha256()
        update_nonbuilding_digest(before, raw, (0, 0, 0))
        update_nonbuilding_digest(after, result, (0, 0, 0))
        self.assertEqual(before.digest(), after.digest())
        original = decode(raw, default_options={'y_coord_down': True})
        self.assertEqual(decoded['buildings']['features'], original['buildings']['features'][:2])

    def test_render_filter_removes_only_buildings_from_fully_outside_tiles(self):
        from mapbox_vector_tile import encode, decode
        raw = encode([dict(name='buildings', features=[dict(geometry=box(500, 500, 1000, 1000), properties={})]),
                      dict(name='water', features=[dict(geometry=box(0, 0, 4096, 4096), properties={})])])
        result = filter_vector_tile(raw, (1, 0, 0), box(.7, .7, .8, .8), Counter())
        self.assertNotIn('buildings', decode(result))
        self.assertIn('water', decode(result))

    def publication_fixture(self, root):
        package, filtered = root / 'original', root / 'filtered'
        package.mkdir(); filtered.mkdir()
        assets = []
        for name in ['buildings_index.bin.gz', 'tiles.pmtiles', 'roads.geojson.gz']:
            (package / name).write_bytes(b'original-' + name.encode())
            (filtered / name).write_bytes(b'filtered-' + name.encode())
            assets.append(dict(path=name, bytes=(package / name).stat().st_size, sha256=digest(package / name)))
        manifest = dict(tileId='test', labelPolicy='preserve-labels', assets=assets)
        (package / 'map-manifest.json').write_text(json.dumps(manifest))
        report = dict(version=VERSION, tileId='test', ownershipGeometrySha256='geometry', sourceIndexSha256=digest(package / assets[0]['path']),
                      indexSha256=digest(filtered / assets[0]['path']),
                      map=dict(sourceSha256=digest(package / 'tiles.pmtiles'), sha256=digest(filtered / 'tiles.pmtiles'), nonBuildingDigest='verified'))
        (filtered / 'building-filter.json').write_text(json.dumps(report))
        return package, filtered, manifest

    def test_publish_preserves_other_assets_and_backs_up_originals(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            package, filtered, original = self.publication_fixture(root)
            published = publish_package(package, filtered, root / 'backups')
            self.assertEqual(published['labelPolicy'], original['labelPolicy'])
            self.assertEqual(published['assets'][2], original['assets'][2])
            for asset in published['assets'][:2]:
                self.assertEqual(digest(package / asset['path']), asset['sha256'])
                self.assertEqual((package / asset['path']).stat().st_size, asset['bytes'])
            self.assertEqual(json.loads((root / 'backups/test/map-manifest.json').read_text()), original)
            self.assertEqual(verified_publication(package, 'test', 'geometry')['version'], VERSION)
            with self.assertRaisesRegex(ValueError, 'boundary changed'):
                verified_publication(package, 'test', 'different')
            (package / 'tiles.pmtiles').write_bytes(b'changed archive')
            with self.assertRaisesRegex(ValueError, 'artifact changed'):
                verified_publication(package, 'test', 'geometry')

    def test_boundary_hash_is_independent_of_source_alias_and_unrelated_features(self):
        geometry = mapping(MultiPolygon([box(0, 0, 1, 1), box(2, 0, 3, 1)]))
        first = dict(features=[dict(properties=dict(tile_id='JP_PREF_13'), geometry=geometry)])
        second = dict(features=[dict(properties=dict(tile_id='JP_TOKYO_MAINLAND'), geometry=geometry),
                                dict(properties=dict(tile_id='other'), geometry=mapping(box(10, 10, 11, 11)))])
        mask, fingerprint = ownership_mask(first, 'JP_PREF_13')
        other, other_fingerprint = ownership_mask(second, 'JP_TOKYO_MAINLAND')
        self.assertEqual(fingerprint, other_fingerprint)
        self.assertTrue(mask.equals(other))
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            ownership_mask(first, 'missing')

    def test_publish_rejects_stale_source_before_writing(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            package, filtered, original = self.publication_fixture(root)
            (package / 'tiles.pmtiles').write_bytes(b'newer source')
            with self.assertRaisesRegex(ValueError, 'Original package hash mismatch'):
                publish_package(package, filtered, root / 'backups')
            self.assertFalse((root / 'backups').exists())
            self.assertEqual(json.loads((package / 'map-manifest.json').read_text()), original)

    def test_publish_rolls_back_if_second_replacement_fails(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            package, filtered, original = self.publication_fixture(root)
            replace = Path.replace
            def fail_second(path, target):
                if path.name == 'tiles.pmtiles.ownership-staged':
                    raise OSError('simulated file lock')
                return replace(path, target)
            with patch.object(Path, 'replace', fail_second), self.assertRaisesRegex(OSError, 'file lock'):
                publish_package(package, filtered, root / 'backups')
            for asset in original['assets']:
                self.assertEqual(digest(package / asset['path']), asset['sha256'])
            self.assertEqual(json.loads((package / 'map-manifest.json').read_text()), original)

    def test_pmtiles_roundtrip_preserves_labels_and_rejects_double_filter(self):
        from mapbox_vector_tile import encode
        from pmtiles.writer import Writer
        from pmtiles.reader import Reader, MemorySource
        from pmtiles.tile import Compression, TileType
        raw = encode([dict(name='buildings', features=[dict(geometry=box(500, 500, 1000, 1000), properties={})]),
                      dict(name='water', features=[dict(geometry=box(0, 0, 4096, 4096), properties={})])])
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / 'source.pmtiles', root / 'target.pmtiles'
            with source.open('wb') as stream:
                writer = Writer(stream)
                writer.write_tile(0, raw)
                writer.finalize(dict(tile_compression=Compression.NONE, tile_type=TileType.MVT,
                                     min_zoom=0, max_zoom=0, min_lon_e7=-1800000000, min_lat_e7=-850000000,
                                     max_lon_e7=1800000000, max_lat_e7=850000000, center_zoom=0,
                                     center_lon_e7=0, center_lat_e7=0), {'labelPolicy': 'keep'})
            report = filter_pmtiles(source, target, box(130, 30, 140, 40))
            self.assertEqual(report['removedFeatures'], 1)
            metadata = Reader(MemorySource(target.read_bytes())).metadata()
            self.assertEqual(metadata['labelPolicy'], 'keep')
            self.assertEqual(metadata['ownershipBuildingFilter'], VERSION)
            with self.assertRaisesRegex(ValueError, 'already filtered'):
                filter_pmtiles(target, root / 'again.pmtiles', box(130, 30, 140, 40))


if __name__ == '__main__':
    unittest.main()
