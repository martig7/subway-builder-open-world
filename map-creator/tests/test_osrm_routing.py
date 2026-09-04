from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from open_world_map_creator.routing.osrm import OsrmRouter


class _OsrmHandler(BaseHTTPRequestHandler):
    calls: list[str] = []
    lock = threading.Lock()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        destinations = query["destinations"][0].split(";")
        with self.lock:
            self.calls.append(self.path)
        payload = {
            "code": "Ok",
            "durations": [[100.0 + index for index, _ in enumerate(destinations)]],
            "distances": [[1000.0 + index for index, _ in enumerate(destinations)]],
        }
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format: str, *args: object) -> None:
        del format, args


class OsrmRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        _OsrmHandler.calls = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _OsrmHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _router(self, cache_path: Path, dataset_id: str = "japan-test-v1") -> OsrmRouter:
        return OsrmRouter(
            base_url=f"http://127.0.0.1:{self.server.server_port}",
            profile="driving",
            dataset_id=dataset_id,
            cache_path=cache_path,
            workers=2,
            max_table_coordinates=10,
        )

    def test_persists_each_pair_and_only_misses_when_a_point_moves(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cache_path = Path(temporary) / "route-cache.sqlite3"
            options = {
                "fallback_speed_mps": 10.0,
                "fallback_circuity": 1.0,
                "max_routed_direct_metres": 3_000_000.0,
                "max_snap_metres": 5_000.0,
                "max_detour_ratio": 3.0,
                "progress": lambda message: None,
            }
            router = self._router(cache_path)
            routes = router.route_pairs(
                [
                    (("home", "work-a"), (139.0, 35.0), (139.1, 35.1)),
                    (("home", "work-b"), (139.0, 35.0), (139.2, 35.2)),
                    (("duplicate", "work-a"), (139.0, 35.0), (139.1, 35.1)),
                ],
                **options,
            )
            router.close()

            self.assertEqual(len(_OsrmHandler.calls), 1)
            self.assertEqual(routes[("home", "work-a")].seconds, 100)
            self.assertEqual(routes[("duplicate", "work-a")].seconds, 100)
            self.assertEqual(routes[("home", "work-b")].seconds, 101)

            router = self._router(cache_path)
            cached = router.route_pairs(
                [(("home", "work-a"), (139.0, 35.0), (139.1, 35.1))],
                **options,
            )
            self.assertEqual(cached[("home", "work-a")].metres, 1000)
            self.assertEqual(len(_OsrmHandler.calls), 1)

            moved = router.route_pairs(
                [(("home", "work-a"), (139.0001, 35.0), (139.1, 35.1))],
                **options,
            )
            router.close()
            self.assertEqual(moved[("home", "work-a")].source, "osrm")
            self.assertEqual(len(_OsrmHandler.calls), 2)

    def test_dataset_identity_invalidates_the_route_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            cache_path = Path(temporary) / "route-cache.sqlite3"
            options = {
                "fallback_speed_mps": 10.0,
                "fallback_circuity": 1.0,
                "max_routed_direct_metres": 3_000_000.0,
                "max_snap_metres": 5_000.0,
                "max_detour_ratio": 3.0,
                "progress": lambda message: None,
            }
            first = self._router(cache_path, "japan-v1")
            first.route_pairs([("pair", (139.0, 35.0), (139.1, 35.1))], **options)
            first.close()
            second = self._router(cache_path, "japan-v2")
            second.route_pairs([("pair", (139.0, 35.0), (139.1, 35.1))], **options)
            second.close()

            self.assertEqual(len(_OsrmHandler.calls), 2)


if __name__ == "__main__":
    unittest.main()
