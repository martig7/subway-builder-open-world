import gzip
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from open_world_map_creator.routing.route_geometry import HEADER, ENTRY, MAGIC, OsrmGeometry, demand_routes, write_archive


class RouteGeometryTests(unittest.TestCase):
    def test_archive_is_searchable_and_deduplicates_geometry(self):
        record = dict(origin=[1, 2], destination=[3, 4], polyline='abc', source='stored-osrm')
        with TemporaryDirectory() as directory:
            root = Path(directory)
            report = write_archive(root, 'driving-routes', [('native-b', record), ('cross-a', record)])
            self.assertEqual(report['routes'], 2)
            self.assertEqual(report['uniqueRecords'], 1)
            index = (root / 'driving-routes.idx').read_bytes()
            self.assertEqual(HEADER.unpack_from(index), (MAGIC, 1, 2))
            entries = [ENTRY.unpack_from(index, HEADER.size + i * ENTRY.size) for i in range(2)]
            self.assertEqual([e[0] for e in entries], sorted(hashlib.sha256(i.encode()).digest()[:16] for i in ['native-b', 'cross-a']))
            self.assertEqual(entries[0][1:], entries[1][1:])
            _, offset, length, _ = entries[0]
            self.assertEqual(json.loads(gzip.decompress((root / 'driving-routes.bin').read_bytes()[offset:offset + length])), record)
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                write_archive(root, 'duplicate', [('same', record), ('same', record)])

    def test_native_and_cross_inputs_use_demand_endpoints(self):
        native = dict(points=[dict(id='h', location=[1, 2]), dict(id='w', location=[3, 4])],
                      pops=[dict(id='local', residenceId='h', jobId='w')])
        cross = dict(popFields=['id', 'homePoint', 'workPoint'], points=[['h', 1, 2], ['w', 3, 4]], pops=[['cross', 0, 1]])
        self.assertEqual(list(demand_routes(native)), [('local', [1, 2], [3, 4])])
        self.assertEqual(list(demand_routes(cross, True)), [('cross', [1, 2], [3, 4])])

    def test_osrm_no_route_is_explicit_but_server_failures_abort_generation(self):
        class Response:
            status = 400
            def read(self): return b'{"code":"NoRoute"}'
        class Connection:
            def request(self, *args): pass
            def getresponse(self): return Response()
            def close(self): pass
        with patch('http.client.HTTPConnection', return_value=Connection()), patch('time.sleep'):
            router = OsrmGeometry('http://127.0.0.1:5000')
            result = router(([1, 2], [3, 4]))
            self.assertEqual(result['source'], 'geometric-no-road-route')
            self.assertIsNone(result['polyline'])
            with patch.object(Response, 'read', return_value=b'{"code":"InternalError"}'):
                with self.assertRaisesRegex(RuntimeError, 'HTTP 400'):
                    router(([1, 2], [3, 4]))
