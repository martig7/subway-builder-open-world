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
CROSS_OSRM_PUBLICATION = "individual-osrm-cross-v1"
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


def _refresh_enriched_tile_manifest(
    manifest: dict[str, Any],
    tile_root: Path,
    driving_model: dict[str, Any] | None = None,
) -> dict[str, Any]:
    assets_by_path = {asset["path"]: asset for asset in manifest.get("assets", [])}
    for filename in (
        "demand_data.json.gz",
        "cross_commutes.json",
        "cross_demand.json.gz",
    ):
        path = tile_root / filename
        asset = assets_by_path.setdefault(filename, {"path": filename})
        asset["bytes"] = path.stat().st_size
        asset["sha256"] = _sha256(path)
    manifest["assets"] = [assets_by_path[key] for key in sorted(assets_by_path)]
    manifest["sha256"] = assets_by_path["demand_data.json.gz"]["sha256"]
    manifest["drivingModel"] = driving_model or _driving_model()
    return manifest


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
class MajorRoadHierarchy:
    core_nodes: np.ndarray
    component_by_node: np.ndarray
    portals_by_component: tuple[np.ndarray, ...]
    shortcut_neighbors: dict[int, list[tuple[int, float, float]]]
    report: dict[str, Any]


@dataclass
class RoadGraph:
    coordinates: np.ndarray
    indptr: np.ndarray
    indices: np.ndarray
    seconds: np.ndarray
    metres: np.ndarray
    components: np.ndarray
    transformer: Transformer
    major_nodes: np.ndarray | None = None

    def __post_init__(self) -> None:
        self._tree = cKDTree(self.coordinates)
        self._best_seconds = np.full(len(self.coordinates), np.inf, dtype=np.float64)
        self._best_metres = np.zeros(len(self.coordinates), dtype=np.float64)
        if self.major_nodes is not None:
            self.major_nodes = np.asarray(self.major_nodes, dtype=np.bool_)
            if len(self.major_nodes) != len(self.coordinates):
                raise ValueError("major-road node mask length does not match graph nodes")
        self._hierarchy: MajorRoadHierarchy | None = None

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

    def _local_dijkstra(
        self,
        component: int,
        start: int,
        targets: set[int],
    ) -> dict[int, tuple[float, float]]:
        hierarchy = self._hierarchy
        if hierarchy is None:
            raise RuntimeError("major-road hierarchy is not prepared")
        portals = set(map(int, hierarchy.portals_by_component[component]))
        best_seconds: dict[int, float] = {start: 0.0}
        best_metres: dict[int, float] = {start: 0.0}
        queue: list[tuple[float, float, int]] = [(0.0, 0.0, start)]
        remaining = set(targets)
        results: dict[int, tuple[float, float]] = {}
        while queue and remaining:
            elapsed, elapsed_metres, node = heapq.heappop(queue)
            if elapsed != best_seconds.get(node) or elapsed_metres != best_metres.get(node):
                continue
            if node in remaining:
                results[node] = (elapsed, elapsed_metres)
                remaining.remove(node)
                if not remaining:
                    break
            node_is_core = bool(hierarchy.core_nodes[node])
            for offset in range(int(self.indptr[node]), int(self.indptr[node + 1])):
                neighbor = int(self.indices[offset])
                if node_is_core:
                    allowed = hierarchy.component_by_node[neighbor] == component
                else:
                    allowed = (
                        hierarchy.component_by_node[neighbor] == component
                        or neighbor in portals
                    )
                if not allowed:
                    continue
                candidate = elapsed + float(self.seconds[offset])
                candidate_metres = elapsed_metres + float(self.metres[offset])
                known = best_seconds.get(neighbor, math.inf)
                known_metres = best_metres.get(neighbor, math.inf)
                if candidate < known or (candidate == known and candidate_metres < known_metres):
                    best_seconds[neighbor] = candidate
                    best_metres[neighbor] = candidate_metres
                    heapq.heappush(queue, (candidate, candidate_metres, neighbor))
        return results

    def prepare_major_road_hierarchy(
        self,
        *,
        maximum_partition_nodes: int = 512,
        maximum_partition_portals: int = 12,
        progress: Any | None = None,
    ) -> dict[str, Any]:
        """Contract bounded minor-road partitions without changing shortest paths."""
        started = time.perf_counter()
        emit = progress or (lambda _: None)
        emit("[road-routing] major-access hierarchy started")
        node_count = self.node_count
        if self.major_nodes is None:
            raise RuntimeError("graph was built without major-road classification")
        original_core = np.asarray(self.major_nodes, dtype=np.bool_)
        minor_nodes = np.flatnonzero(~original_core)
        component_by_node = np.full(node_count, -1, dtype=np.int32)
        if len(minor_nodes) == 0:
            report = {
                "contractedPartitionCount": 0,
                "promotedPartitionCount": 0,
                "contractedNodes": 0,
                "coreNodes": node_count,
                "portalReferences": 0,
                "shortcutDirectedEdges": 0,
                "buildSeconds": round(time.perf_counter() - started, 3),
            }
            self._hierarchy = MajorRoadHierarchy(
                original_core.copy(), component_by_node, (), {}, report
            )
            emit("[road-routing] major-access hierarchy complete (no minor partitions)")
            return report

        topology = csr_matrix(
            (np.ones(len(self.indices), dtype=np.int8), self.indices, self.indptr),
            shape=(node_count, node_count),
        )
        minor_topology = topology[minor_nodes][:, minor_nodes]
        partition_count, minor_labels = connected_components(
            minor_topology, directed=False, return_labels=True
        )
        component_by_node[minor_nodes] = minor_labels.astype(np.int32, copy=False)
        partition_sizes = np.bincount(minor_labels, minlength=partition_count)
        portal_sets: list[set[int]] = [set() for _ in range(partition_count)]
        for core_node in np.flatnonzero(original_core):
            start_offset = int(self.indptr[core_node])
            end_offset = int(self.indptr[core_node + 1])
            neighbor_partitions = component_by_node[self.indices[start_offset:end_offset]]
            for partition in np.unique(neighbor_partitions[neighbor_partitions >= 0]):
                portal_sets[int(partition)].add(int(core_node))

        promoted = np.asarray([
            int(partition_sizes[index]) > maximum_partition_nodes
            or len(portal_sets[index]) > maximum_partition_portals
            for index in range(partition_count)
        ], dtype=np.bool_)
        core_nodes = original_core.copy()
        if np.any(promoted):
            promoted_minor = promoted[minor_labels]
            core_nodes[minor_nodes[promoted_minor]] = True

        contracted_labels = np.flatnonzero(~promoted)
        dense_label = np.full(partition_count, -1, dtype=np.int32)
        dense_label[contracted_labels] = np.arange(len(contracted_labels), dtype=np.int32)
        contracted_component_by_node = np.full(node_count, -1, dtype=np.int32)
        retained_minor = ~promoted[minor_labels]
        contracted_component_by_node[minor_nodes[retained_minor]] = dense_label[minor_labels[retained_minor]]
        portals_by_component = tuple(
            np.asarray(sorted(portal_sets[int(label)]), dtype=np.int64)
            for label in contracted_labels
        )
        hierarchy = MajorRoadHierarchy(
            core_nodes=core_nodes,
            component_by_node=contracted_component_by_node,
            portals_by_component=portals_by_component,
            shortcut_neighbors={},
            report={},
        )
        self._hierarchy = hierarchy

        shortcut_neighbors: dict[int, list[tuple[int, float, float]]] = {}
        last_progress = time.perf_counter()
        for partition, portals in enumerate(portals_by_component):
            portal_ids = list(map(int, portals))
            if len(portal_ids) >= 2:
                for portal_index, portal in enumerate(portal_ids[:-1]):
                    targets = set(portal_ids[portal_index + 1 :])
                    routes = self._local_dijkstra(partition, portal, targets)
                    for target, (route_seconds, route_metres) in routes.items():
                        shortcut_neighbors.setdefault(portal, []).append(
                            (target, route_seconds, route_metres)
                        )
                        shortcut_neighbors.setdefault(target, []).append(
                            (portal, route_seconds, route_metres)
                        )
            now = time.perf_counter()
            if now - last_progress >= 15:
                emit(
                    f"[road-routing] major-access hierarchy {partition + 1}/"
                    f"{len(portals_by_component)} partitions"
                )
                last_progress = now
        hierarchy.shortcut_neighbors = shortcut_neighbors
        report = {
            "contractedPartitionCount": len(contracted_labels),
            "promotedPartitionCount": int(np.count_nonzero(promoted)),
            "contractedNodes": int(np.count_nonzero(~core_nodes)),
            "coreNodes": int(np.count_nonzero(core_nodes)),
            "portalReferences": sum(len(portals) for portals in portals_by_component),
            "shortcutDirectedEdges": sum(len(edges) for edges in shortcut_neighbors.values()),
            "maximumPartitionNodes": maximum_partition_nodes,
            "maximumPartitionPortals": maximum_partition_portals,
            "buildSeconds": round(time.perf_counter() - started, 3),
        }
        hierarchy.report = report
        emit(
            "[road-routing] major-access hierarchy complete "
            f"({report['contractedPartitionCount']} partitions, "
            f"{report['contractedNodes']} contracted nodes, "
            f"{report['shortcutDirectedEdges']} directed shortcuts, "
            f"{report['buildSeconds']:.1f}s)"
        )
        return report

    def _hierarchical_astar(self, start: int, destination: int) -> tuple[float, float] | None:
        hierarchy = self._hierarchy
        if hierarchy is None:
            return self._astar(start, destination)
        if start == destination:
            return 0.0, 0.0
        if self.components[start] != self.components[destination]:
            return None

        start_component = int(hierarchy.component_by_node[start])
        destination_component = int(hierarchy.component_by_node[destination])
        direct: tuple[float, float] | None = None
        if start_component >= 0 and start_component == destination_component:
            direct = self._local_dijkstra(start_component, start, {destination}).get(destination)

        if hierarchy.core_nodes[start]:
            starts = {start: (0.0, 0.0)}
        elif start_component >= 0:
            starts = self._local_dijkstra(
                start_component,
                start,
                set(map(int, hierarchy.portals_by_component[start_component])),
            )
        else:
            starts = {}
        if hierarchy.core_nodes[destination]:
            destinations = {destination: (0.0, 0.0)}
        elif destination_component >= 0:
            destinations = self._local_dijkstra(
                destination_component,
                destination,
                set(map(int, hierarchy.portals_by_component[destination_component])),
            )
        else:
            destinations = {}
        if not starts or not destinations:
            return direct

        destination_xy = self.coordinates[destination]
        best_seconds = self._best_seconds
        best_metres = self._best_metres
        touched: list[int] = []
        queue: list[tuple[float, float, int]] = []
        for node, (elapsed, elapsed_metres) in starts.items():
            if elapsed < best_seconds[node] or (
                elapsed == best_seconds[node] and elapsed_metres < best_metres[node]
            ):
                if not math.isfinite(best_seconds[node]):
                    touched.append(node)
                best_seconds[node] = elapsed
                best_metres[node] = elapsed_metres
                heuristic = math.dist(self.coordinates[node], destination_xy) / MAX_SPEED_MPS
                heapq.heappush(queue, (elapsed + heuristic, elapsed, node))

        result = direct
        while queue:
            estimate, elapsed, node = heapq.heappop(queue)
            if elapsed != best_seconds[node]:
                continue
            if result is not None and estimate > result[0]:
                break
            destination_leg = destinations.get(node)
            if destination_leg is not None:
                candidate = (
                    elapsed + destination_leg[0],
                    best_metres[node] + destination_leg[1],
                )
                if result is None or candidate < result:
                    result = candidate

            def relax(neighbor: int, edge_seconds: float, edge_metres: float) -> None:
                candidate = elapsed + edge_seconds
                candidate_metres = best_metres[node] + edge_metres
                if candidate < best_seconds[neighbor] or (
                    candidate == best_seconds[neighbor] and candidate_metres < best_metres[neighbor]
                ):
                    if not math.isfinite(best_seconds[neighbor]):
                        touched.append(neighbor)
                    best_seconds[neighbor] = candidate
                    best_metres[neighbor] = candidate_metres
                    heuristic = math.dist(self.coordinates[neighbor], destination_xy) / MAX_SPEED_MPS
                    heapq.heappush(queue, (candidate + heuristic, candidate, neighbor))

            for offset in range(int(self.indptr[node]), int(self.indptr[node + 1])):
                neighbor = int(self.indices[offset])
                if hierarchy.core_nodes[neighbor]:
                    relax(neighbor, float(self.seconds[offset]), float(self.metres[offset]))
            for neighbor, edge_seconds, edge_metres in hierarchy.shortcut_neighbors.get(node, ()):
                relax(neighbor, edge_seconds, edge_metres)
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
        road = self._hierarchical_astar(int(snapped[0]), int(snapped[1]))
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
    prepare_major_access_hierarchy: bool = False,
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
    node_is_major: list[bool] | None = [] if prepare_major_access_hierarchy else None
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
        if node_is_major is not None:
            node_is_major.append(False)
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
                        if node_is_major is not None and road_class in {"highway", "major"}:
                            node_is_major[left] = True
                            node_is_major[right] = True
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
        np.asarray(node_is_major, dtype=np.bool_) if node_is_major is not None else None,
    )
    hierarchy_report = (
        graph.prepare_major_road_hierarchy(progress=progress)
        if prepare_major_access_hierarchy
        else None
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
    if hierarchy_report is not None:
        report["majorAccessHierarchy"] = hierarchy_report
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


def _route_many(
    router: Any,
    requests: Iterable[tuple[Any, tuple[float, float], tuple[float, float]]],
    *,
    route_options: dict[str, float],
    fallback_speed_mps: float,
    fallback_circuity: float,
    progress: Any,
) -> dict[Any, RouteResult]:
    materialized = list(requests)
    batch = getattr(router, "route_pairs", None)
    if callable(batch):
        return batch(
            materialized,
            fallback_speed_mps=fallback_speed_mps,
            fallback_circuity=fallback_circuity,
            progress=progress,
            **route_options,
        )
    return {
        key: router.route(
            origin,
            destination,
            fallback_speed_mps=fallback_speed_mps,
            fallback_circuity=fallback_circuity,
            **route_options,
        )
        for key, origin, destination in materialized
    }


def _route_one(
    router: Any,
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    route_options: dict[str, float],
    fallback_speed_mps: float,
    fallback_circuity: float,
    progress: Any,
) -> RouteResult:
    return _route_many(
        router,
        [(0, origin, destination)],
        route_options=route_options,
        fallback_speed_mps=fallback_speed_mps,
        fallback_circuity=fallback_circuity,
        progress=progress,
    )[0]


def _read_json_or_gzip(path: Path) -> dict[str, Any]:
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as source:
            return json.load(source)
    return json.loads(path.read_text(encoding="utf-8"))


def _selective_routing_plan(
    demand: Path,
    invalidation_path: Path,
) -> dict[str, Any]:
    """Validate endpoint identities and return the smallest safe rerouting set."""
    invalidation = _read_json_or_gzip(invalidation_path)
    native: dict[str, set[str]] = {}
    for tile_id, entry in invalidation["native"].items():
        payload = _read_gzip_json(demand / "tiles" / tile_id / "demand_data.json.gz")
        actual = {str(pop["id"]): pop for pop in payload["pops"]}
        selected: set[str] = set()
        for captured in entry["pops"]:
            pop_id = str(captured["id"])
            pop = actual.get(pop_id)
            if pop is None:
                raise ValueError(f"Missing invalidated native cohort {tile_id}:{pop_id}")
            identity = (
                str(pop["residenceId"]),
                str(pop["jobId"]),
                int(pop["size"]),
            )
            expected = (
                str(captured["residenceId"]),
                str(captured["jobId"]),
                int(captured["size"]),
            )
            if identity != expected:
                raise ValueError(
                    f"Invalidated native cohort changed {tile_id}:{pop_id}: {identity} != {expected}"
                )
            selected.add(pop_id)
        native[tile_id] = selected

    cross = _read_gzip_json(demand / "world" / "cross_demand.json.gz")
    point_fields = {name: index for index, name in enumerate(cross["pointFields"])}
    pop_fields = {name: index for index, name in enumerate(cross["popFields"])}
    points = cross["points"]
    actual_cross = {str(pop[pop_fields["id"]]): pop for pop in cross["pops"]}
    affected = {
        (str(partition[0]), str(partition[1]))
        for partition in invalidation["cross"]["affectedPartitions"]
    }
    captured_partitions: set[tuple[str, str]] = set()
    for captured in invalidation["cross"]["pops"]:
        pop_id = str(captured["id"])
        pop = actual_cross.get(pop_id)
        if pop is None:
            raise ValueError(f"Missing invalidated cross cohort {pop_id}")
        home = points[int(pop[pop_fields["homePoint"]])]
        work = points[int(pop[pop_fields["workPoint"]])]
        identity = (
            str(home[point_fields["id"]]),
            str(work[point_fields["id"]]),
            int(pop[pop_fields["mass"]]),
            str(home[point_fields["tileId"]]),
            str(work[point_fields["tileId"]]),
        )
        expected = (
            str(captured["homePointId"]),
            str(captured["workPointId"]),
            int(captured["mass"]),
            str(captured["partition"][0]),
            str(captured["partition"][1]),
        )
        if identity != expected:
            raise ValueError(f"Invalidated cross cohort changed {pop_id}: {identity} != {expected}")
        captured_partitions.add((identity[3], identity[4]))
    if captured_partitions != affected:
        raise ValueError(
            f"Cross invalidation partitions changed: {sorted(captured_partitions)} != {sorted(affected)}"
        )
    return {
        "manifest": invalidation,
        "nativePopIds": native,
        "crossPartitions": affected,
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
    invalidation_path: str | Path | None = None,
    cross_only: bool = False,
    route_backend: Any | None = None,
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
    if cross_only and invalidation_path is not None:
        raise ValueError("cross_only and invalidation_path are mutually exclusive")
    selective_plan = (
        _selective_routing_plan(demand, Path(invalidation_path))
        if invalidation_path is not None
        else None
    )
    if cross_only:
        cross_input = _read_gzip_json(demand / "world" / "cross_demand.json.gz")
        pf = {name: index for index, name in enumerate(cross_input["pointFields"])}
        cf = {name: index for index, name in enumerate(cross_input["popFields"])}
        selective_plan = {"nativePopIds": {}, "crossPartitions": {
            (str(cross_input["points"][int(pop[cf["homePoint"]])][pf["tileId"]]),
             str(cross_input["points"][int(pop[cf["workPoint"]])][pf["tileId"]]))
            for pop in cross_input["pops"]
        }}
    if selective_plan is not None:
        progress(
            "[road-routing] selective plan validated "
            f"({sum(map(len, selective_plan['nativePopIds'].values()))} native cohorts, "
            f"{len(selective_plan['crossPartitions'])} cross partitions)"
        )
    catalog = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    tile_ids = [str(tile["id"]) for tile in catalog["tiles"] if tile.get("status") == "selected"]
    transformer = Transformer.from_crs("EPSG:4326", catalog["crs"], always_xy=True)
    if route_backend is None:
        progress("[road-routing] started generated-road graph build")
        router, graph_report = build_road_graph(
            catalog_path,
            maps_dir,
            maximum_edge_metres=maximum_edge_metres,
            progress=progress,
        )
        driving_model = _driving_model()
        routing_fingerprint = {
            "provider": "generated-roads",
            "roads": {
                tile_id: _sha256(Path(maps_dir) / tile_id / "roads.geojson.gz")
                for tile_id in tile_ids
            },
        }
    else:
        router = route_backend
        driving_model = dict(router.driving_model())
        graph_report = dict(router.report())
        routing_fingerprint = dict(router.input_fingerprint)
        progress(
            "[road-routing] using external routing backend "
            f"{driving_model['provider']} ({driving_model.get('datasetId', 'unversioned')})"
        )
    individual_cross = driving_model["provider"] == "osrm"
    cross_publication = CROSS_OSRM_PUBLICATION if individual_cross else "sampled-tile-pair-v1"
    stage = demand.parent / f".{demand.name}-road-routing-stage"
    input_fingerprint = {
        "crossPublication": cross_publication,
        "crossOnly": cross_only,
        "catalog": _sha256(Path(catalog_path)),
        "routingBackend": routing_fingerprint,
        "nativeDemand": {
            tile_id: _sha256(demand / "tiles" / tile_id / "demand_data.json.gz")
            for tile_id in tile_ids
        },
        "crossDemand": _sha256(demand / "world" / "cross_demand.json.gz"),
        "crossCommutes": _sha256(demand / "world" / "cross_commutes.json"),
    }
    if invalidation_path is not None:
        input_fingerprint["routingInvalidation"] = _sha256(Path(invalidation_path))
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
            if selective_plan is not None:
                rerouted = len(selective_plan["nativePopIds"].get(tile_id, ()))
                counts["recoveredSelectiveNativeRoutes"] += rerouted
                counts["preservedNativeRoutes"] += recovered_routes - rerouted
            progress(f"[road-routing] recovered native routes {tile_index}/{len(tile_ids)} {tile_id} ({recovered_routes})")
            continue
        payload = _read_gzip_json(source_path)
        points = {str(point["id"]): tuple(map(float, point["location"])) for point in payload["points"]}
        route_started = time.perf_counter()
        last_route_progress = route_started
        selected_pop_ids = (
            selective_plan["nativePopIds"].get(tile_id, set())
            if selective_plan is not None
            else None
        )
        selected_pops = (
            [pop for pop in payload["pops"] if str(pop["id"]) in selected_pop_ids]
            if selected_pop_ids is not None
            else payload["pops"]
        )
        route_total = len(selected_pops)
        if selective_plan is not None:
            preserved = len(payload["pops"]) - route_total
            counts["routes"] += preserved
            counts["nativeRoutes"] += preserved
            counts["preservedNativeRoutes"] += preserved
        if selected_pop_ids is not None and not selected_pops:
            staged_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, staged_path)
            progress(f"[road-routing] preserved native file {tile_id}")
            continue
        unique_requests: dict[
            tuple[str, str], tuple[tuple[float, float], tuple[float, float]]
        ] = {}
        for pop in selected_pops:
            pair = (str(pop["residenceId"]), str(pop["jobId"]))
            unique_requests.setdefault(pair, (points[pair[0]], points[pair[1]]))
        progress(f"[road-routing] native started {tile_index}/{len(tile_ids)} {tile_id} ({route_total} selected)")
        route_cache = _route_many(
            router,
            (
                (pair, coordinates[0], coordinates[1])
                for pair, coordinates in unique_requests.items()
            ),
            route_options=route_options,
            fallback_speed_mps=LOCAL_FALLBACK_SPEED_MPS,
            fallback_circuity=1.0,
            progress=progress,
        )
        counts["nativeSearches"] += len(unique_requests)
        counts["reusedNativeRoutes"] += route_total - len(unique_requests)
        for pop_index, pop in enumerate(selected_pops, 1):
            pair = (str(pop["residenceId"]), str(pop["jobId"]))
            route = route_cache[pair]
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
        progress(
            f"[road-routing] native routes {tile_index}/{len(tile_ids)} {tile_id} "
            f"({route_total} rerouted, {len(payload['pops']) - route_total} preserved)"
        )

    cross_path = demand / "world" / "cross_demand.json.gz"
    cross = _read_gzip_json(cross_path)
    point_fields = {name: index for index, name in enumerate(cross["pointFields"])}
    pop_fields = {name: index for index, name in enumerate(cross["popFields"])}
    cross_points = [
        (float(point[point_fields["longitude"]]), float(point[point_fields["latitude"]]))
        for point in cross["points"]
    ]
    projected_cross_points = [
        tuple(map(float, transformer.transform(*point))) for point in cross_points
    ]
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
        completed_selective_partitions = {
            tuple(map(str, partition))
            for partition in partition_cache.get("selectiveCompletedPartitions", [])
        }
    elif selective_plan is not None and (demand / "reports" / route_models_name).is_file():
        partition_cache = json.loads((demand / "reports" / route_models_name).read_text(encoding="utf-8"))
        models = dict(partition_cache.get("models", {}))
        completed_selective_partitions = set()
    else:
        models = {}
        completed_selective_partitions = set()
    search_counts: Counter[str] = Counter()

    def direct_metres(pop: list[Any]) -> float:
        home_xy = projected_cross_points[int(pop[pop_fields["homePoint"]])]
        work_xy = projected_cross_points[int(pop[pop_fields["workPoint"]])]
        return max(1.0, math.dist(home_xy, work_xy))

    partition_items = sorted(partition_indices.items())
    for partition_number, (partition, indices) in enumerate(partition_items, 1):
        cache_key = f"{partition[0]}->{partition[1]}"
        partition_selected = (
            selective_plan is None or partition in selective_plan["crossPartitions"]
        )
        if not partition_selected:
            if cache_key not in models:
                raise ValueError(f"Cannot preserve missing cross routing model {cache_key}")
            counts["routes"] += len(indices)
            counts["crossRoutes"] += len(indices)
            counts["preservedCrossRoutes"] += len(indices)
            search_counts["preservedPartitions"] += 1
            progress(
                f"[road-routing] cross partition preserved {partition_number}/{len(partition_items)} "
                f"{cache_key} ({len(indices)} cohorts)"
            )
            continue
        if selective_plan is not None and partition not in completed_selective_partitions:
            models.pop(cache_key, None)
        if individual_cross:
            routes = _route_many(
                router,
                ((i, cross_points[int(cross["pops"][i][pop_fields["homePoint"]])],
                  cross_points[int(cross["pops"][i][pop_fields["workPoint"]])]) for i in indices),
                route_options=route_options,
                fallback_speed_mps=CROSS_FALLBACK_SPEED_MPS,
                fallback_circuity=CROSS_FALLBACK_CIRCUITY,
                progress=progress,
            )
            for i in indices:
                route = routes[i]
                cross["pops"][i][pop_fields["drivingSeconds"]] = route.seconds
                cross["pops"][i][pop_fields["drivingDistance"]] = route.metres
                _route_counter(counts, route)
                counts["crossRoutes"] += 1
                search_counts[route.source] += 1
                search_counts["searches"] += 1
            models[cache_key] = {"provider": cross_publication, "routes": len(indices)}
            if selective_plan is not None:
                completed_selective_partitions.add(partition)
            progress(f"[road-routing] individual cross partition {partition_number}/{len(partition_items)} "
                     f"{cache_key} ({len(indices)} cohorts)")
            continue
        model = models.get(cache_key)
        if model is None:
            sample_count = min(max(1, cross_samples_per_tile_pair), len(indices))
            sample_offsets = sorted({min(len(indices) - 1, (offset * len(indices)) // sample_count) for offset in range(sample_count)})
            road_ratios: list[float] = []
            seconds_per_direct_metre: list[float] = []
            sampled_pop_ids: list[str] = []
            passenger_ferry_samples = 0
            for sample_number, offset in enumerate(sample_offsets, 1):
                pop = cross["pops"][indices[offset]]
                direct = direct_metres(pop)
                if direct > max_routed_direct_metres:
                    continue
                progress(
                    f"[road-routing] cross sample started {partition_number}/{len(partition_items)} "
                    f"{cache_key} {sample_number}/{len(sample_offsets)}"
                )
                route = _route_one(
                    router,
                    cross_points[int(pop[pop_fields["homePoint"]])],
                    cross_points[int(pop[pop_fields["workPoint"]])],
                    route_options=route_options,
                    fallback_speed_mps=CROSS_FALLBACK_SPEED_MPS,
                    fallback_circuity=CROSS_FALLBACK_CIRCUITY,
                    progress=progress,
                )
                search_counts[route.source] += 1
                search_counts["searches"] += 1
                sampled_pop_ids.append(str(pop[pop_fields["id"]]))
                if route.source == "osrm-passenger-ferry":
                    passenger_ferry_samples += 1
                if route.source in {"generated-road-graph", "osrm"}:
                    road_ratios.append(route.metres / direct)
                    seconds_per_direct_metre.append(route.seconds / direct)
                progress(
                    f"[road-routing] cross sample complete {partition_number}/{len(partition_items)} "
                    f"{cache_key} {sample_number}/{len(sample_offsets)} {route.source}"
                )
            if road_ratios:
                model = {
                    "provider": (
                        "osrm-tile-pair-model"
                        if driving_model["provider"] == "osrm"
                        else "generated-road-tile-pair-model"
                    ),
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
            if passenger_ferry_samples:
                model["passengerFerrySamples"] = passenger_ferry_samples
            models[cache_key] = model
            if selective_plan is not None:
                completed_selective_partitions.add(partition)
            _write_json(partition_cache_path, {
                "schemaVersion": 1,
                "graphVersion": driving_model["graphVersion"],
                "samplesPerTilePair": cross_samples_per_tile_pair,
                "selectiveCompletedPartitions": [
                    list(item) for item in sorted(completed_selective_partitions)
                ],
                "models": models,
            })
        else:
            search_counts["recoveredPartitions"] += 1

        # Fixed transfers and water/land proportions cannot be extrapolated by
        # tile-pair distance. The water overlay checks all endpoints, including
        # island failures not represented by the partition's mainland samples.
        ferry_routes = {}
        if model.get("passengerFerrySamples") or getattr(router, "requires_exact_cross_routes", False):
            ferry_routes = _route_many(
                router,
                ((i, cross_points[int(cross["pops"][i][pop_fields["homePoint"]])],
                  cross_points[int(cross["pops"][i][pop_fields["workPoint"]])]) for i in indices),
                route_options=route_options,
                fallback_speed_mps=CROSS_FALLBACK_SPEED_MPS,
                fallback_circuity=CROSS_FALLBACK_CIRCUITY,
                progress=progress,
            )
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
            ferry_route = ferry_routes.get(pop_index)
            if ferry_route is not None and ferry_route.source in {"osrm-passenger-ferry", "osrm-straight-water"}:
                route = ferry_route
            pop[pop_fields["drivingSeconds"]] = route.seconds
            pop[pop_fields["drivingDistance"]] = route.metres
            _route_counter(counts, route)
            counts["crossRoutes"] += 1
        progress(
            f"[road-routing] cross partition {partition_number}/{len(partition_items)} "
            f"{cache_key} ({len(indices)} cohorts, {model['roadSamples']} road samples)"
        )
    _write_json(partition_cache_path, {
        "schemaVersion": 1,
        "graphVersion": driving_model["graphVersion"],
        "samplesPerTilePair": cross_samples_per_tile_pair,
        "selectiveCompletedPartitions": [
            list(item) for item in sorted(completed_selective_partitions)
        ],
        "models": models,
    })
    cross["drivingModel"] = driving_model
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
    commutes["drivingModel"] = driving_model
    _write_json(stage / "world" / "cross_commutes.json", commutes)

    for tile_id in tile_ids:
        tile_cross = {**cross, "tileId": tile_id}
        tile_commutes = {**commutes, "tileId": tile_id}
        tile_root = stage / "tiles" / tile_id
        _gzip_json(tile_root / "cross_demand.json.gz", tile_cross)
        _write_json(tile_root / "cross_commutes.json", tile_commutes)
        manifest = json.loads((demand / "tiles" / tile_id / "manifest.json").read_text(encoding="utf-8"))
        _write_json(
            tile_root / "manifest.json",
            _refresh_enriched_tile_manifest(manifest, tile_root, driving_model),
        )

    demand_report_path = demand / "reports" / demand_report_name
    demand_report = json.loads(demand_report_path.read_text(encoding="utf-8"))
    demand_report.setdefault("aggregation", {})["drivingModel"] = driving_model
    demand_report["roadRouting"] = {
        "report": routing_report_name,
        "graphVersion": driving_model["graphVersion"],
        "completed": True,
    }
    _write_json(stage / "reports" / demand_report_name, demand_report)

    routing_report = {
        "schemaVersion": 1,
        "status": "complete",
        "kind": f"{driving_model['provider']} driving-time splice",
        "consumerManifestId": consumer_manifest_id,
        "graph": dict(router.report()) if route_backend is not None else graph_report,
        "drivingModel": driving_model,
        "policy": {
            "crossPublication": cross_publication,
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
    if selective_plan is not None:
        routing_report["selection"] = {
            "mode": "cross-only" if cross_only else "invalidation",
            **({"invalidationSha256": _sha256(Path(invalidation_path))} if invalidation_path is not None else {}),
            "nativeCohortCount": sum(map(len, selective_plan["nativePopIds"].values())),
            "crossPartitionCount": len(selective_plan["crossPartitions"]),
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
