from __future__ import annotations

import gzip
import hashlib
import heapq
import json
import math
import os
import shutil
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

import numpy as np
from pyproj import Transformer
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree


GRAPH_VERSION = "generated-roads-v1"
SPEED_KPH = {"highway": 85.0, "major": 50.0, "minor": 30.0}
SPEED_MPS = {road_class: speed / 3.6 for road_class, speed in SPEED_KPH.items()}
MAX_SPEED_MPS = max(SPEED_MPS.values())
DEFAULT_MAX_EDGE_METRES = 250.0
DEFAULT_MAX_ROUTED_DIRECT_METRES = 250_000.0
DEFAULT_MAX_SNAP_METRES = 5_000.0
DEFAULT_MAX_DETOUR_RATIO = 3.0
DEFAULT_CROSS_SAMPLES_PER_TILE_PAIR = 4
LOCAL_FALLBACK_SPEED_MPS = 13.4
CROSS_FALLBACK_SPEED_MPS = 40 / 3.6
CROSS_FALLBACK_CIRCUITY = 1.3


def _gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
            output.write(payload)
    os.replace(temporary, path)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def _read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stable_id(*parts: object) -> str:
    return hashlib.sha256("\x1f".join(map(str, parts)).encode("utf-8")).hexdigest()[:24]


def _coordinate_key(longitude: float, latitude: float) -> int:
    longitude_integer = int(round((longitude + 180.0) * 10_000_000))
    latitude_integer = int(round((latitude + 90.0) * 10_000_000))
    return (longitude_integer << 32) | latitude_integer


def _geometry_lines(geometry: dict[str, Any]) -> Iterator[list[list[float]]]:
    geometry_type = geometry.get("type")
    coordinates = geometry.get("coordinates") or []
    if geometry_type == "LineString":
        yield coordinates
    elif geometry_type == "MultiLineString":
        yield from coordinates


@dataclass(frozen=True)
class RouteResult:
    seconds: int
    metres: int
    source: str
    snap_metres: float


@dataclass
class RoadGraph:
    coordinates: np.ndarray
    indptr: np.ndarray
    indices: np.ndarray
    seconds: np.ndarray
    metres: np.ndarray
    components: np.ndarray
    transformer: Transformer

    def __post_init__(self) -> None:
        self._tree = cKDTree(self.coordinates)
        self._best_seconds = np.full(len(self.coordinates), np.inf, dtype=np.float64)
        self._best_metres = np.zeros(len(self.coordinates), dtype=np.float64)

    @property
    def node_count(self) -> int:
        return len(self.coordinates)

    @property
    def directed_edge_count(self) -> int:
        return len(self.indices)

    def projected(self, longitude: float, latitude: float) -> tuple[float, float]:
        x, y = self.transformer.transform(longitude, latitude)
        return float(x), float(y)

    def _astar(self, start: int, destination: int) -> tuple[float, float] | None:
        if start == destination:
            return 0.0, 0.0
        if self.components[start] != self.components[destination]:
            return None
        destination_xy = self.coordinates[destination]
        best_seconds = self._best_seconds
        best_metres = self._best_metres
        best_seconds[start] = 0.0
        best_metres[start] = 0.0
        touched = [start]
        initial = math.dist(self.coordinates[start], destination_xy) / MAX_SPEED_MPS
        queue: list[tuple[float, float, int]] = [(initial, 0.0, start)]
        result: tuple[float, float] | None = None
        while queue:
            _, elapsed, node = heapq.heappop(queue)
            if elapsed != best_seconds[node]:
                continue
            if node == destination:
                result = elapsed, best_metres[node]
                break
            for offset in range(int(self.indptr[node]), int(self.indptr[node + 1])):
                neighbor = int(self.indices[offset])
                candidate = elapsed + float(self.seconds[offset])
                candidate_metres = best_metres[node] + float(self.metres[offset])
                if candidate < best_seconds[neighbor] or (
                    candidate == best_seconds[neighbor] and candidate_metres < best_metres[neighbor]
                ):
                    if not math.isfinite(best_seconds[neighbor]):
                        touched.append(neighbor)
                    best_seconds[neighbor] = candidate
                    best_metres[neighbor] = candidate_metres
                    heuristic = math.dist(self.coordinates[neighbor], destination_xy) / MAX_SPEED_MPS
                    heapq.heappush(queue, (candidate + heuristic, candidate, neighbor))
        best_seconds[np.asarray(touched, dtype=np.int64)] = np.inf
        return result

    def route(
        self,
        origin: tuple[float, float],
        destination: tuple[float, float],
        *,
        fallback_speed_mps: float,
        fallback_circuity: float,
        max_routed_direct_metres: float,
        max_snap_metres: float,
        max_detour_ratio: float,
    ) -> RouteResult:
        origin_xy = np.asarray(self.projected(*origin), dtype=np.float64)
        destination_xy = np.asarray(self.projected(*destination), dtype=np.float64)
        direct_metres = max(1.0, float(np.linalg.norm(destination_xy - origin_xy)))
        fallback_metres = direct_metres * fallback_circuity

        def fallback(reason: str) -> RouteResult:
            return RouteResult(
                max(60, round(fallback_metres / fallback_speed_mps)),
                max(1, round(fallback_metres)),
                reason,
                0.0,
            )

        if direct_metres > max_routed_direct_metres:
            return fallback("geometric-long-distance")
        snap_distances, snapped = self._tree.query(np.vstack((origin_xy, destination_xy)), k=1)
        snap_total = float(snap_distances[0] + snap_distances[1])
        if max(snap_distances) > max_snap_metres:
            return fallback("geometric-snap-too-far")
        road = self._astar(int(snapped[0]), int(snapped[1]))
        if road is None:
            return fallback("geometric-disconnected")
        seconds = road[0] + snap_total / SPEED_MPS["minor"]
        metres = road[1] + snap_total
        if metres > direct_metres * max_detour_ratio:
            return fallback("geometric-excessive-detour")
        return RouteResult(max(60, round(seconds)), max(1, round(metres)), "generated-road-graph", snap_total)


def _retained_runs(
    road_path: Path,
    bounds: tuple[float, float, float, float],
    transformer: Transformer,
) -> Iterator[tuple[str, list[tuple[float, float]], np.ndarray]]:
    payload = _read_gzip_json(road_path)
    minimum_x, minimum_y, maximum_x, maximum_y = bounds
    for feature in payload.get("features", []):
        road_class = str((feature.get("properties") or {}).get("roadClass", "minor"))
        if road_class not in SPEED_MPS:
            road_class = "minor"
        for raw_line in _geometry_lines(feature.get("geometry") or {}):
            if len(raw_line) < 2:
                continue
            longitudes = np.asarray([float(point[0]) for point in raw_line], dtype=np.float64)
            latitudes = np.asarray([float(point[1]) for point in raw_line], dtype=np.float64)
            x, y = transformer.transform(longitudes, latitudes)
            projected = np.column_stack((x, y))
            midpoints = (projected[:-1] + projected[1:]) / 2
            included = (
                (midpoints[:, 0] >= minimum_x)
                & (midpoints[:, 0] < maximum_x)
                & (midpoints[:, 1] >= minimum_y)
                & (midpoints[:, 1] < maximum_y)
            )
            start: int | None = None
            for segment_index, keep in enumerate(included):
                if keep and start is None:
                    start = segment_index
                if start is not None and (not keep or segment_index == len(included) - 1):
                    end = segment_index + 1 if keep and segment_index == len(included) - 1 else segment_index
                    raw = [(float(longitudes[index]), float(latitudes[index])) for index in range(start, end + 1)]
                    yield road_class, raw, projected[start : end + 1]
                    start = None


def build_road_graph(
    catalog_path: str | Path,
    maps_dir: str | Path,
    *,
    maximum_edge_metres: float = DEFAULT_MAX_EDGE_METRES,
    progress: Any = print,
) -> tuple[RoadGraph, dict[str, Any]]:
    started = time.perf_counter()
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    transformer = Transformer.from_crs("EPSG:4326", catalog["crs"], always_xy=True)
    tiles = [tile for tile in catalog["tiles"] if tile.get("status") == "selected"]
    maps = Path(maps_dir)
    endpoint_chunks: list[np.ndarray] = []
    retained_segments = 0
    for tile_index, tile in enumerate(tiles, 1):
        path = maps / str(tile["id"]) / "roads.geojson.gz"
        if not path.is_file():
            raise FileNotFoundError(f"missing generated roads: {path}")
        tile_keys: list[int] = []
        for _, raw, _ in _retained_runs(path, tuple(tile["ownershipProjected"]), transformer):
            keys = [_coordinate_key(*coordinate) for coordinate in raw]
            for left, right in zip(keys, keys[1:]):
                tile_keys.extend((left, right))
                retained_segments += 1
        endpoint_chunks.append(np.asarray(tile_keys, dtype=np.uint64))
        progress(f"[road-routing] topology pass {tile_index}/{len(tiles)} {tile['id']}")
    endpoint_keys = np.concatenate(endpoint_chunks) if endpoint_chunks else np.asarray([], dtype=np.uint64)
    del endpoint_chunks
    endpoint_keys.sort()
    if len(endpoint_keys) == 0:
        raise ValueError("generated road packages contain no routable segments")
    boundaries = np.flatnonzero(np.r_[True, endpoint_keys[1:] != endpoint_keys[:-1], True])
    counts = np.diff(boundaries)
    unique_keys = endpoint_keys[boundaries[:-1]]
    junction_keys = {int(key) for key in unique_keys[counts != 2]}
    del endpoint_keys, boundaries, counts, unique_keys

    node_ids: dict[int, int] = {}
    node_coordinates: list[tuple[float, float]] = []
    edge_left: list[int] = []
    edge_right: list[int] = []
    edge_seconds: list[float] = []
    edge_metres: list[float] = []

    def node_id(key: int, coordinate: np.ndarray) -> int:
        existing = node_ids.get(key)
        if existing is not None:
            return existing
        result = len(node_coordinates)
        node_ids[key] = result
        node_coordinates.append((float(coordinate[0]), float(coordinate[1])))
        return result

    for tile_index, tile in enumerate(tiles, 1):
        path = maps / str(tile["id"]) / "roads.geojson.gz"
        for road_class, raw, projected in _retained_runs(path, tuple(tile["ownershipProjected"]), transformer):
            keys = [_coordinate_key(*coordinate) for coordinate in raw]
            chain_start = 0
            accumulated = 0.0
            for segment_index in range(len(raw) - 1):
                accumulated += float(np.linalg.norm(projected[segment_index + 1] - projected[segment_index]))
                endpoint = segment_index + 1
                split = endpoint == len(raw) - 1 or keys[endpoint] in junction_keys or accumulated >= maximum_edge_metres
                if not split:
                    continue
                if accumulated > 0:
                    left = node_id(keys[chain_start], projected[chain_start])
                    right = node_id(keys[endpoint], projected[endpoint])
                    if left != right:
                        edge_left.append(left)
                        edge_right.append(right)
                        edge_metres.append(accumulated)
                        edge_seconds.append(accumulated / SPEED_MPS[road_class])
                chain_start = endpoint
                accumulated = 0.0
        progress(f"[road-routing] graph pass {tile_index}/{len(tiles)} {tile['id']}")

    node_count = len(node_coordinates)
    left = np.asarray(edge_left, dtype=np.int64)
    right = np.asarray(edge_right, dtype=np.int64)
    rows = np.concatenate((left, right))
    columns = np.concatenate((right, left))
    time_values = np.asarray(edge_seconds + edge_seconds, dtype=np.float64)
    metre_values = np.asarray(edge_metres + edge_metres, dtype=np.float64)
    count_values = np.ones(len(rows), dtype=np.float64)
    shape = (node_count, node_count)
    count_graph = csr_matrix((count_values, (rows, columns)), shape=shape)
    time_graph = csr_matrix((time_values, (rows, columns)), shape=shape)
    metre_graph = csr_matrix((metre_values, (rows, columns)), shape=shape)
    if not (np.array_equal(time_graph.indptr, count_graph.indptr) and np.array_equal(time_graph.indices, count_graph.indices)):
        raise AssertionError("road time/count sparse graphs disagree")
    if not (np.array_equal(metre_graph.indptr, count_graph.indptr) and np.array_equal(metre_graph.indices, count_graph.indices)):
        raise AssertionError("road distance/count sparse graphs disagree")
    time_graph.data /= count_graph.data
    metre_graph.data /= count_graph.data
    component_count, components = connected_components(time_graph, directed=False, return_labels=True)
    graph = RoadGraph(
        np.asarray(node_coordinates, dtype=np.float64),
        time_graph.indptr,
        time_graph.indices,
        time_graph.data,
        metre_graph.data,
        components,
        transformer,
    )
    report = {
        "graphVersion": GRAPH_VERSION,
        "speedKph": SPEED_KPH,
        "maximumEdgeMetres": maximum_edge_metres,
        "tileCount": len(tiles),
        "retainedRawSegments": retained_segments,
        "nodes": graph.node_count,
        "directedEdges": graph.directed_edge_count,
        "components": int(component_count),
        "buildSeconds": round(time.perf_counter() - started, 3),
    }
    return graph, report


def _driving_model() -> dict[str, Any]:
    return {
        "provider": "generated-road-graph",
        "label": "generated roads: highway 85, major 50, minor 30 km/h; geometric fallback",
        "graphVersion": GRAPH_VERSION,
        "speedKph": SPEED_KPH,
        "longDistanceFallback": "straight-line ×1.3 at 40 km/h",
    }


def _route_counter(counter: Counter[str], route: RouteResult) -> None:
    counter[route.source] += 1
    counter["routes"] += 1
    counter["drivingSeconds"] += route.seconds
    counter["drivingMetres"] += route.metres
    counter["snapMetres"] += round(route.snap_metres)


def _route_options(
    *,
    max_routed_direct_metres: float,
    max_snap_metres: float,
    max_detour_ratio: float,
) -> dict[str, float]:
    return {
        "max_routed_direct_metres": max_routed_direct_metres,
        "max_snap_metres": max_snap_metres,
        "max_detour_ratio": max_detour_ratio,
    }


def enrich_generated_road_driving(
    catalog_path: str | Path,
    maps_dir: str | Path,
    demand_dir: str | Path,
    *,
    report_namespace: str,
    consumer_manifest_id: str,
    demand_report_name: str | None = None,
    build_hash_prefix: str | None = None,
    maximum_edge_metres: float = DEFAULT_MAX_EDGE_METRES,
    max_routed_direct_metres: float = DEFAULT_MAX_ROUTED_DIRECT_METRES,
    max_snap_metres: float = DEFAULT_MAX_SNAP_METRES,
    max_detour_ratio: float = DEFAULT_MAX_DETOUR_RATIO,
    cross_samples_per_tile_pair: int = DEFAULT_CROSS_SAMPLES_PER_TILE_PAIR,
    resume: bool = True,
    progress: Any = print,
) -> dict[str, Any]:
    if not report_namespace or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in report_namespace):
        raise ValueError(f"invalid report namespace: {report_namespace}")
    demand_report_name = demand_report_name or f"{report_namespace}-demand.json"
    routing_report_name = f"{report_namespace}-road-routing.json"
    route_models_name = f"{report_namespace}-cross-route-models.json"
    build_hash_prefix = build_hash_prefix or f"{report_namespace}-road-v1"
    started = time.perf_counter()
    demand = Path(demand_dir)
    progress("[road-routing] started graph build")
    graph, graph_report = build_road_graph(
        catalog_path, maps_dir, maximum_edge_metres=maximum_edge_metres, progress=progress
    )
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    tile_ids = [str(tile["id"]) for tile in catalog["tiles"] if tile.get("status") == "selected"]
    stage = demand.parent / f".{demand.name}-road-routing-stage"
    input_fingerprint = {
        "catalog": _sha256(Path(catalog_path)),
        "roads": {
            tile_id: _sha256(Path(maps_dir) / tile_id / "roads.geojson.gz")
            for tile_id in tile_ids
        },
        "nativeDemand": {
            tile_id: _sha256(demand / "tiles" / tile_id / "demand_data.json.gz")
            for tile_id in tile_ids
        },
        "crossDemand": _sha256(demand / "world" / "cross_demand.json.gz"),
        "crossCommutes": _sha256(demand / "world" / "cross_commutes.json"),
    }
    stage_fingerprint_path = stage / ".routing-inputs.json"
    if stage.exists():
        recovered_fingerprint = (
            json.loads(stage_fingerprint_path.read_text(encoding="utf-8"))
            if stage_fingerprint_path.is_file()
            else None
        )
        if not resume or recovered_fingerprint != input_fingerprint:
            progress("[road-routing] discarded stale stage after input fingerprint change")
            shutil.rmtree(stage)
    _write_json(stage_fingerprint_path, input_fingerprint)
    route_options = _route_options(
        max_routed_direct_metres=max_routed_direct_metres,
        max_snap_metres=max_snap_metres,
        max_detour_ratio=max_detour_ratio,
    )
    counts: Counter[str] = Counter()

    for tile_index, tile_id in enumerate(tile_ids, 1):
        source_path = demand / "tiles" / tile_id / "demand_data.json.gz"
        staged_path = stage / "tiles" / tile_id / "demand_data.json.gz"
        if resume and staged_path.is_file():
            recovered = _read_gzip_json(staged_path)
            recovered_routes = len(recovered["pops"])
            counts["routes"] += recovered_routes
            counts["nativeRoutes"] += recovered_routes
            counts["recoveredNativeRoutes"] += recovered_routes
            progress(f"[road-routing] recovered native routes {tile_index}/{len(tile_ids)} {tile_id} ({recovered_routes})")
            continue
        payload = _read_gzip_json(source_path)
        points = {str(point["id"]): tuple(map(float, point["location"])) for point in payload["points"]}
        route_started = time.perf_counter()
        last_route_progress = route_started
        route_total = len(payload["pops"])
        route_cache: dict[tuple[str, str], RouteResult] = {}
        progress(f"[road-routing] native started {tile_index}/{len(tile_ids)} {tile_id} ({route_total})")
        for pop_index, pop in enumerate(payload["pops"], 1):
            pair = (str(pop["residenceId"]), str(pop["jobId"]))
            route = route_cache.get(pair)
            if route is None:
                route = graph.route(
                    points[pair[0]],
                    points[pair[1]],
                    fallback_speed_mps=LOCAL_FALLBACK_SPEED_MPS,
                    fallback_circuity=1.0,
                    **route_options,
                )
                route_cache[pair] = route
                counts["nativeSearches"] += 1
            else:
                counts["reusedNativeRoutes"] += 1
            pop["drivingSeconds"] = route.seconds
            pop["drivingDistance"] = route.metres
            _route_counter(counts, route)
            counts["nativeRoutes"] += 1
            now = time.perf_counter()
            if pop_index == route_total or now - last_route_progress >= 15:
                progress(
                    f"[road-routing] native progress {tile_index}/{len(tile_ids)} {tile_id} "
                    f"{pop_index}/{route_total} ({pop_index / max(1, route_total):.1%}, "
                    f"{len(route_cache)} unique searches, {now - route_started:.1f}s)"
                )
                last_route_progress = now
        _gzip_json(staged_path, payload)
        progress(f"[road-routing] native routes {tile_index}/{len(tile_ids)} {tile_id} ({len(payload['pops'])})")

    cross_path = demand / "world" / "cross_demand.json.gz"
    cross = _read_gzip_json(cross_path)
    point_fields = {name: index for index, name in enumerate(cross["pointFields"])}
    pop_fields = {name: index for index, name in enumerate(cross["popFields"])}
    cross_points = [
        (float(point[point_fields["longitude"]]), float(point[point_fields["latitude"]]))
        for point in cross["points"]
    ]
    projected_cross_points = [graph.projected(*point) for point in cross_points]
    tile_field = point_fields["tileId"]
    partition_indices: dict[tuple[str, str], list[int]] = {}
    for pop_index, pop in enumerate(cross["pops"]):
        home_point = cross["points"][int(pop[pop_fields["homePoint"]])]
        work_point = cross["points"][int(pop[pop_fields["workPoint"]])]
        key = (str(home_point[tile_field]), str(work_point[tile_field]))
        partition_indices.setdefault(key, []).append(pop_index)

    partition_cache_path = stage / "reports" / route_models_name
    if resume and partition_cache_path.is_file():
        partition_cache = json.loads(partition_cache_path.read_text(encoding="utf-8"))
        models: dict[str, dict[str, Any]] = dict(partition_cache.get("models", {}))
    else:
        models = {}
    search_counts: Counter[str] = Counter()

    def direct_metres(pop: list[Any]) -> float:
        home_xy = projected_cross_points[int(pop[pop_fields["homePoint"]])]
        work_xy = projected_cross_points[int(pop[pop_fields["workPoint"]])]
        return max(1.0, math.dist(home_xy, work_xy))

    partition_items = sorted(partition_indices.items())
    for partition_number, (partition, indices) in enumerate(partition_items, 1):
        cache_key = f"{partition[0]}->{partition[1]}"
        model = models.get(cache_key)
        if model is None:
            sample_count = min(max(1, cross_samples_per_tile_pair), len(indices))
            sample_offsets = sorted({min(len(indices) - 1, (offset * len(indices)) // sample_count) for offset in range(sample_count)})
            road_ratios: list[float] = []
            seconds_per_direct_metre: list[float] = []
            sampled_pop_ids: list[str] = []
            for sample_number, offset in enumerate(sample_offsets, 1):
                pop = cross["pops"][indices[offset]]
                direct = direct_metres(pop)
                if direct > max_routed_direct_metres:
                    continue
                progress(
                    f"[road-routing] cross sample started {partition_number}/{len(partition_items)} "
                    f"{cache_key} {sample_number}/{len(sample_offsets)}"
                )
                route = graph.route(
                    cross_points[int(pop[pop_fields["homePoint"]])],
                    cross_points[int(pop[pop_fields["workPoint"]])],
                    fallback_speed_mps=CROSS_FALLBACK_SPEED_MPS,
                    fallback_circuity=CROSS_FALLBACK_CIRCUITY,
                    **route_options,
                )
                search_counts[route.source] += 1
                search_counts["searches"] += 1
                sampled_pop_ids.append(str(pop[pop_fields["id"]]))
                if route.source == "generated-road-graph":
                    road_ratios.append(route.metres / direct)
                    seconds_per_direct_metre.append(route.seconds / direct)
                progress(
                    f"[road-routing] cross sample complete {partition_number}/{len(partition_items)} "
                    f"{cache_key} {sample_number}/{len(sample_offsets)} {route.source}"
                )
            if road_ratios:
                model = {
                    "provider": "generated-road-tile-pair-model",
                    "distanceRatio": round(float(np.median(road_ratios)), 8),
                    "secondsPerDirectMetre": round(float(np.median(seconds_per_direct_metre)), 10),
                    "roadSamples": len(road_ratios),
                    "sampledPopIds": sampled_pop_ids,
                }
            else:
                model = {
                    "provider": "geometric-tile-pair-fallback",
                    "distanceRatio": CROSS_FALLBACK_CIRCUITY,
                    "secondsPerDirectMetre": CROSS_FALLBACK_CIRCUITY / CROSS_FALLBACK_SPEED_MPS,
                    "roadSamples": 0,
                    "sampledPopIds": sampled_pop_ids,
                }
            models[cache_key] = model
            _write_json(partition_cache_path, {
                "schemaVersion": 1,
                "graphVersion": GRAPH_VERSION,
                "samplesPerTilePair": cross_samples_per_tile_pair,
                "models": models,
            })
        else:
            search_counts["recoveredPartitions"] += 1

        for pop_index in indices:
            pop = cross["pops"][pop_index]
            direct = direct_metres(pop)
            if direct > max_routed_direct_metres:
                distance = direct * CROSS_FALLBACK_CIRCUITY
                route = RouteResult(
                    max(60, round(distance / CROSS_FALLBACK_SPEED_MPS)),
                    max(1, round(distance)),
                    "geometric-long-distance",
                    0.0,
                )
            else:
                route = RouteResult(
                    max(60, round(direct * float(model["secondsPerDirectMetre"]))),
                    max(1, round(direct * float(model["distanceRatio"]))),
                    str(model["provider"]),
                    0.0,
                )
            pop[pop_fields["drivingSeconds"]] = route.seconds
            pop[pop_fields["drivingDistance"]] = route.metres
            _route_counter(counts, route)
            counts["crossRoutes"] += 1
        progress(
            f"[road-routing] cross partition {partition_number}/{len(partition_items)} "
            f"{cache_key} ({len(indices)} cohorts, {model['roadSamples']} road samples)"
        )
    cross["drivingModel"] = _driving_model()
    _gzip_json(stage / "world" / "cross_demand.json.gz", cross)

    commutes = json.loads((demand / "world" / "cross_commutes.json").read_text(encoding="utf-8"))
    gateway_ids = list(cross["gateways"])
    totals: dict[tuple[str, str, str], list[int]] = {}
    for pop in cross["pops"]:
        home_point = cross["points"][int(pop[pop_fields["homePoint"]])]
        work_point = cross["points"][int(pop[pop_fields["workPoint"]])]
        key = (
            str(home_point[tile_field]),
            str(work_point[tile_field]),
            str(gateway_ids[int(pop[pop_fields["gateway"]])]),
        )
        mass = int(pop[pop_fields["mass"]])
        total = totals.setdefault(key, [0, 0])
        total[0] += mass
        total[1] += mass * int(pop[pop_fields["drivingSeconds"]])
    for bucket in commutes["buckets"]:
        key = (str(bucket["homeTileId"]), str(bucket["workTileId"]), str(bucket["gatewayId"]))
        mass, weighted_seconds = totals[key]
        if mass != int(bucket["mass"]):
            raise AssertionError(f"cross-commute mass changed for {key}: {mass} != {bucket['mass']}")
        bucket["defaultTravelSeconds"] = max(60, round(weighted_seconds / mass))
    commute_parts = [
        f"{bucket['id']}:{bucket['mass']}:{bucket['defaultTravelSeconds']}" for bucket in commutes["buckets"]
    ]
    commutes["buildHash"] = f"{build_hash_prefix}-{_stable_id(*commute_parts)}"
    commutes["drivingModel"] = _driving_model()
    _write_json(stage / "world" / "cross_commutes.json", commutes)

    for tile_id in tile_ids:
        tile_cross = {**cross, "tileId": tile_id}
        tile_commutes = {**commutes, "tileId": tile_id}
        tile_root = stage / "tiles" / tile_id
        _gzip_json(tile_root / "cross_demand.json.gz", tile_cross)
        _write_json(tile_root / "cross_commutes.json", tile_commutes)
        manifest = json.loads((demand / "tiles" / tile_id / "manifest.json").read_text(encoding="utf-8"))
        assets_by_path = {asset["path"]: asset for asset in manifest.get("assets", [])}
        for filename in ("demand_data.json.gz", "cross_commutes.json", "cross_demand.json.gz"):
            path = tile_root / filename
            asset = assets_by_path.setdefault(filename, {"path": filename})
            asset["bytes"] = path.stat().st_size
            asset["sha256"] = _sha256(path)
        manifest["assets"] = [assets_by_path[key] for key in sorted(assets_by_path)]
        manifest["drivingModel"] = _driving_model()
        _write_json(tile_root / "manifest.json", manifest)

    demand_report_path = demand / "reports" / demand_report_name
    demand_report = json.loads(demand_report_path.read_text(encoding="utf-8"))
    demand_report.setdefault("aggregation", {})["drivingModel"] = _driving_model()
    demand_report["roadRouting"] = {
        "report": routing_report_name,
        "graphVersion": GRAPH_VERSION,
        "completed": True,
    }
    _write_json(stage / "reports" / demand_report_name, demand_report)

    routing_report = {
        "schemaVersion": 1,
        "status": "complete",
        "kind": "generated-road driving-time splice",
        "consumerManifestId": consumer_manifest_id,
        "graph": graph_report,
        "drivingModel": _driving_model(),
        "policy": {
            "maxRoutedDirectMetres": max_routed_direct_metres,
            "maxSnapMetres": max_snap_metres,
            "maxDetourRatio": max_detour_ratio,
            "minimumDrivingSeconds": 60,
            "crossSamplesPerTilePair": cross_samples_per_tile_pair,
            "crossPartitionCount": len(partition_items),
        },
        "routes": dict(sorted(counts.items())),
        "crossSearches": dict(sorted(search_counts.items())),
        "elapsedSeconds": round(time.perf_counter() - started, 3),
    }
    _write_json(stage / "reports" / routing_report_name, routing_report)

    stage_fingerprint_path.unlink(missing_ok=True)
    staged_files = sorted(path for path in stage.rglob("*") if path.is_file())
    for staged in staged_files:
        relative = staged.relative_to(stage)
        destination = demand / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, destination)
    shutil.rmtree(stage)
    progress(f"[road-routing] committed {len(staged_files)} enriched artifacts")
    return routing_report
