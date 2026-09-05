from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

from .generated_roads import RouteResult


CACHE_SCHEMA_VERSION = 1
COORDINATE_PRECISION = 7
EARTH_RADIUS_METRES = 6_371_008.8


def _canonical_coordinate(coordinate: tuple[float, float]) -> tuple[int, int]:
    longitude, latitude = coordinate
    scale = 10**COORDINATE_PRECISION
    return round(float(longitude) * scale), round(float(latitude) * scale)


def _coordinate_text(coordinate: tuple[int, int]) -> str:
    scale = 10**COORDINATE_PRECISION
    return f"{coordinate[0] / scale:.{COORDINATE_PRECISION}f},{coordinate[1] / scale:.{COORDINATE_PRECISION}f}"


def _haversine_metres(
    origin: tuple[float, float], destination: tuple[float, float]
) -> float:
    longitude_a, latitude_a = map(math.radians, origin)
    longitude_b, latitude_b = map(math.radians, destination)
    delta_longitude = longitude_b - longitude_a
    delta_latitude = latitude_b - latitude_a
    haversine = (
        math.sin(delta_latitude / 2) ** 2
        + math.cos(latitude_a)
        * math.cos(latitude_b)
        * math.sin(delta_longitude / 2) ** 2
    )
    return max(1.0, 2 * EARTH_RADIUS_METRES * math.asin(math.sqrt(haversine)))


class PersistentRouteCache:
    """Durable cache keyed by dataset, profile, policy, and exact endpoints."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=NORMAL")
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS route_cache (
                cache_key TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                profile TEXT NOT NULL,
                origin_longitude_e7 INTEGER NOT NULL,
                origin_latitude_e7 INTEGER NOT NULL,
                destination_longitude_e7 INTEGER NOT NULL,
                destination_latitude_e7 INTEGER NOT NULL,
                seconds INTEGER NOT NULL,
                metres INTEGER NOT NULL,
                source TEXT NOT NULL,
                snap_metres REAL NOT NULL,
                captured_at TEXT NOT NULL
            )
            """
        )
        self.connection.execute(
            "CREATE INDEX IF NOT EXISTS route_cache_dataset ON route_cache(dataset_id, profile)"
        )
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cache_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        self.connection.execute(
            "INSERT OR REPLACE INTO cache_metadata(key, value) VALUES('schemaVersion', ?)",
            (str(CACHE_SCHEMA_VERSION),),
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def lookup(self, cache_keys: Iterable[str]) -> dict[str, RouteResult]:
        keys = list(dict.fromkeys(cache_keys))
        result: dict[str, RouteResult] = {}
        for offset in range(0, len(keys), 800):
            chunk = keys[offset : offset + 800]
            placeholders = ",".join("?" for _ in chunk)
            rows = self.connection.execute(
                f"SELECT cache_key, seconds, metres, source, snap_metres "
                f"FROM route_cache WHERE cache_key IN ({placeholders})",
                chunk,
            )
            result.update(
                {
                    str(key): RouteResult(int(seconds), int(metres), str(source), float(snap))
                    for key, seconds, metres, source, snap in rows
                }
            )
        return result

    def store(
        self,
        rows: Iterable[
            tuple[
                str,
                str,
                str,
                tuple[int, int],
                tuple[int, int],
                RouteResult,
            ]
        ],
    ) -> None:
        captured_at = datetime.now(UTC).isoformat()
        self.connection.executemany(
            """
            INSERT OR REPLACE INTO route_cache(
                cache_key, dataset_id, profile,
                origin_longitude_e7, origin_latitude_e7,
                destination_longitude_e7, destination_latitude_e7,
                seconds, metres, source, snap_metres, captured_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                (
                    cache_key,
                    dataset_id,
                    profile,
                    origin[0],
                    origin[1],
                    destination[0],
                    destination[1],
                    route.seconds,
                    route.metres,
                    route.source,
                    route.snap_metres,
                    captured_at,
                )
                for cache_key, dataset_id, profile, origin, destination, route in rows
            ),
        )
        self.connection.commit()


class OsrmRouter:
    """OSRM MLD client with one-to-many requests and crash-safe pair caching."""

    def __init__(
        self,
        *,
        base_url: str,
        profile: str,
        dataset_id: str,
        cache_path: str | Path,
        workers: int = 16,
        max_table_coordinates: int = 100,
        timeout_seconds: float = 60.0,
        retries: int = 3,
    ) -> None:
        if not dataset_id.strip():
            raise ValueError("OSRM dataset ID is required")
        if workers < 1:
            raise ValueError("OSRM workers must be positive")
        if max_table_coordinates < 2:
            raise ValueError("OSRM table requests require at least two coordinates")
        self.base_url = base_url.rstrip("/")
        self.profile = profile
        self.dataset_id = dataset_id
        self.workers = workers
        self.max_table_coordinates = max_table_coordinates
        self.timeout_seconds = timeout_seconds
        self.retries = retries
        self.cache = PersistentRouteCache(cache_path)
        self.stats: Counter[str] = Counter()
        self._stats_lock = threading.Lock()

    def nearest_candidates(self, coordinate, number: int = 8):
        """Cached road-access candidates; callers must validate land ownership.

        Transport/server errors are fatal, not negative connectivity evidence.
        """
        canonical = _canonical_coordinate(coordinate)
        key = hashlib.sha256(json.dumps(
            [self.dataset_id, self.profile, canonical, number, "nearest-v1"]
        ).encode()).hexdigest()
        connection = self.cache.connection
        connection.execute("CREATE TABLE IF NOT EXISTS road_nearest_cache "
                           "(cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL)")
        cached = connection.execute("SELECT result_json FROM road_nearest_cache WHERE cache_key=?", (key,)).fetchone()
        if cached:
            self.stats["nearestCacheHits"] += 1
            return json.loads(cached[0])
        url = (f"{self.base_url}/nearest/v1/{urllib.parse.quote(self.profile)}/"
               f"{_coordinate_text(canonical)}?number={number}")
        for attempt in range(self.retries + 1):
            try:
                with urllib.request.urlopen(url, timeout=self.timeout_seconds) as response:
                    payload = json.load(response)
                if payload.get("code") != "Ok":
                    raise RuntimeError(f"OSRM nearest returned {payload.get('code')}")
                candidates = payload["waypoints"]
                for candidate in candidates:
                    location = candidate["location"]
                    if len(location) != 2 or not all(math.isfinite(v) for v in location):
                        raise ValueError("Invalid OSRM nearest coordinate")
                break
            except (OSError, ValueError, KeyError, TypeError, RuntimeError):
                if attempt == self.retries:
                    raise
                time.sleep(min(2.0, 0.25 * 2 ** attempt))
        connection.execute("INSERT OR REPLACE INTO road_nearest_cache VALUES (?, ?)", (key, json.dumps(candidates)))
        connection.commit()
        self.stats["nearestRequests"] += 1
        return candidates

    def close(self) -> None:
        self.cache.close()

    @property
    def input_fingerprint(self) -> dict[str, Any]:
        return {
            "provider": "osrm",
            "datasetId": self.dataset_id,
            "profile": self.profile,
            "baseUrl": self.base_url,
            "cacheSchemaVersion": CACHE_SCHEMA_VERSION,
        }

    def driving_model(self) -> dict[str, Any]:
        return {
            "provider": "osrm",
            "label": f"OSRM {self.profile} profile ({self.dataset_id})",
            "graphVersion": f"osrm:{self.dataset_id}",
            "datasetId": self.dataset_id,
            "profile": self.profile,
            "longDistanceFallback": "great-circle × configured circuity at configured fallback speed",
        }

    def report(self) -> dict[str, Any]:
        return {
            "provider": "osrm",
            "algorithm": "mld",
            "datasetId": self.dataset_id,
            "profile": self.profile,
            "workers": self.workers,
            "maxTableCoordinates": self.max_table_coordinates,
            "cachePath": str(self.cache.path),
            **dict(sorted(self.stats.items())),
        }

    def _cache_key(
        self,
        origin: tuple[int, int],
        destination: tuple[int, int],
        *,
        fallback_speed_mps: float,
        fallback_circuity: float,
        max_routed_direct_metres: float,
    ) -> str:
        payload = "\x1f".join(
            (
                str(CACHE_SCHEMA_VERSION),
                self.dataset_id,
                self.profile,
                str(origin[0]),
                str(origin[1]),
                str(destination[0]),
                str(destination[1]),
                f"{fallback_speed_mps:.9f}",
                f"{fallback_circuity:.9f}",
                f"{max_routed_direct_metres:.3f}",
            )
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _fallback(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        fallback_speed_mps: float,
        fallback_circuity: float,
        source: str,
    ) -> RouteResult:
        metres = _haversine_metres(origin, destination) * fallback_circuity
        return RouteResult(
            max(60, round(metres / fallback_speed_mps)),
            max(1, round(metres)),
            source,
            0.0,
        )

    def _request_table(
        self,
        origin: tuple[int, int],
        destinations: list[tuple[int, int]],
    ) -> tuple[list[tuple[float | None, float | None]], int]:
        coordinates = [origin, *destinations]
        path = ";".join(_coordinate_text(coordinate) for coordinate in coordinates)
        query = urllib.parse.urlencode(
            {
                "sources": "0",
                "destinations": ";".join(str(index) for index in range(1, len(coordinates))),
                "annotations": "duration,distance",
            }
        )
        url = f"{self.base_url}/table/v1/{urllib.parse.quote(self.profile)}/{path}?{query}"
        last_error: Exception | None = None
        for attempt in range(1, self.retries + 2):
            try:
                with urllib.request.urlopen(url, timeout=self.timeout_seconds) as response:
                    payload = json.load(response)
                if payload.get("code") != "Ok":
                    raise RuntimeError(f"OSRM table response was {payload.get('code')}: {payload.get('message')}")
                durations = payload.get("durations", [[]])[0]
                distances = payload.get("distances", [[]])[0]
                if len(durations) != len(destinations) or len(distances) != len(destinations):
                    raise RuntimeError("OSRM table response size did not match the request")
                return list(zip(durations, distances)), attempt
            except (OSError, urllib.error.URLError, ValueError, RuntimeError) as error:
                last_error = error
                if attempt > self.retries:
                    break
                time.sleep(min(2.0, 0.25 * (2 ** (attempt - 1))))
        raise RuntimeError(f"OSRM table request failed after {self.retries + 1} attempts: {last_error}")

    def route_pairs(
        self,
        requests: Iterable[
            tuple[Any, tuple[float, float], tuple[float, float]]
        ],
        *,
        fallback_speed_mps: float,
        fallback_circuity: float,
        max_routed_direct_metres: float,
        max_snap_metres: float,
        max_detour_ratio: float,
        progress: Any = print,
    ) -> dict[Any, RouteResult]:
        del max_snap_metres, max_detour_ratio
        normalized: list[
            tuple[Any, tuple[float, float], tuple[float, float], tuple[int, int], tuple[int, int], str]
        ] = []
        for request_key, origin, destination in requests:
            canonical_origin = _canonical_coordinate(origin)
            canonical_destination = _canonical_coordinate(destination)
            cache_key = self._cache_key(
                canonical_origin,
                canonical_destination,
                fallback_speed_mps=fallback_speed_mps,
                fallback_circuity=fallback_circuity,
                max_routed_direct_metres=max_routed_direct_metres,
            )
            normalized.append(
                (
                    request_key,
                    origin,
                    destination,
                    canonical_origin,
                    canonical_destination,
                    cache_key,
                )
            )
        cached = self.cache.lookup(item[5] for item in normalized)
        routes: dict[Any, RouteResult] = {}
        missing_by_cache_key: dict[
            str,
            tuple[tuple[float, float], tuple[float, float], tuple[int, int], tuple[int, int]],
        ] = {}
        logical_keys_by_cache_key: dict[str, list[Any]] = defaultdict(list)
        for request_key, origin, destination, canonical_origin, canonical_destination, cache_key in normalized:
            logical_keys_by_cache_key[cache_key].append(request_key)
            route = cached.get(cache_key)
            if route is not None:
                routes[request_key] = route
            else:
                missing_by_cache_key.setdefault(
                    cache_key,
                    (origin, destination, canonical_origin, canonical_destination),
                )
        self.stats["logicalRoutes"] += len(normalized)
        self.stats["cacheHits"] += len(normalized) - sum(
            len(logical_keys_by_cache_key[key]) for key in missing_by_cache_key
        )
        self.stats["cacheMisses"] += len(missing_by_cache_key)

        immediate_rows = []
        routable: dict[tuple[int, int], list[tuple[str, tuple[int, int]]]] = defaultdict(list)
        for cache_key, (origin, destination, canonical_origin, canonical_destination) in missing_by_cache_key.items():
            if _haversine_metres(origin, destination) > max_routed_direct_metres:
                route = self._fallback(
                    origin,
                    destination,
                    fallback_speed_mps=fallback_speed_mps,
                    fallback_circuity=fallback_circuity,
                    source="geometric-long-distance",
                )
                immediate_rows.append(
                    (cache_key, self.dataset_id, self.profile, canonical_origin, canonical_destination, route)
                )
                for request_key in logical_keys_by_cache_key[cache_key]:
                    routes[request_key] = route
                self.stats["geometricLongDistance"] += 1
            else:
                routable[canonical_origin].append((cache_key, canonical_destination))
        if immediate_rows:
            self.cache.store(immediate_rows)

        chunks: list[tuple[tuple[int, int], list[tuple[str, tuple[int, int]]]]] = []
        maximum_destinations = self.max_table_coordinates - 1
        for origin, destinations in routable.items():
            for offset in range(0, len(destinations), maximum_destinations):
                chunks.append((origin, destinations[offset : offset + maximum_destinations]))
        if not chunks:
            return routes

        started = time.perf_counter()
        last_progress = started
        completed = 0
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = {
                executor.submit(
                    self._request_table,
                    origin,
                    [destination for _, destination in destinations],
                ): (origin, destinations)
                for origin, destinations in chunks
            }
            for future in as_completed(futures):
                origin, destinations = futures[future]
                response, attempts = future.result()
                stored_rows = []
                for (cache_key, destination), (seconds, metres) in zip(destinations, response):
                    original_origin, original_destination, _, _ = missing_by_cache_key[cache_key]
                    if seconds is None or metres is None:
                        route = self._fallback(
                            original_origin,
                            original_destination,
                            fallback_speed_mps=fallback_speed_mps,
                            fallback_circuity=fallback_circuity,
                            source="osrm-no-route-fallback",
                        )
                        self.stats["noRouteFallbacks"] += 1
                    else:
                        route = RouteResult(
                            max(60, round(float(seconds))),
                            max(1, round(float(metres))),
                            "osrm",
                            0.0,
                        )
                        self.stats["osrmRoutes"] += 1
                    stored_rows.append(
                        (cache_key, self.dataset_id, self.profile, origin, destination, route)
                    )
                    for request_key in logical_keys_by_cache_key[cache_key]:
                        routes[request_key] = route
                self.cache.store(stored_rows)
                completed += 1
                self.stats["httpRequests"] += 1
                self.stats["httpAttempts"] += attempts
                self.stats["matrixElements"] += len(destinations)
                now = time.perf_counter()
                if completed == len(chunks) or now - last_progress >= 10:
                    progress(
                        f"[road-routing] OSRM cache/checkpoint {completed}/{len(chunks)} requests "
                        f"({self.stats['matrixElements']} elements, {now - started:.1f}s)"
                    )
                    last_progress = now
        return routes

    def route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        **options: Any,
    ) -> RouteResult:
        return self.route_pairs(
            [(0, origin, destination)],
            progress=options.pop("progress", print),
            **options,
        )[0]
