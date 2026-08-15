from __future__ import annotations

import gzip
import heapq
import json
import math
import os
import statistics
import time
from pathlib import Path
from typing import Any

from .util import write_json


SPEED_MPS = {"highway": 27.0, "major": 20.0, "minor": 13.4}


def _rss_bytes() -> int:
    try:
        import psutil  # type: ignore[import-not-found]

        return int(psutil.Process(os.getpid()).memory_info().rss)
    except ImportError:
        return 0


def _distance_m(left: tuple[float, float], right: tuple[float, float]) -> float:
    latitude = math.radians((left[1] + right[1]) / 2)
    dx = math.radians(right[0] - left[0]) * 6_371_008.8 * math.cos(latitude)
    dy = math.radians(right[1] - left[1]) * 6_371_008.8
    return math.hypot(dx, dy)


def _dijkstra(adjacency: list[list[tuple[int, float, float]]], start: int, end: int) -> tuple[float, float] | None:
    distances = {start: 0.0}
    road_metres = {start: 0.0}
    queue = [(0.0, start)]
    while queue:
        seconds, node = heapq.heappop(queue)
        if seconds != distances.get(node):
            continue
        if node == end:
            return seconds, road_metres[node]
        for neighbor, edge_seconds, edge_metres in adjacency[node]:
            candidate = seconds + edge_seconds
            if candidate < distances.get(neighbor, math.inf):
                distances[neighbor] = candidate
                road_metres[neighbor] = road_metres[node] + edge_metres
                heapq.heappush(queue, (candidate, neighbor))
    return None


def _build_graph(path: Path) -> tuple[list[tuple[float, float]], list[list[tuple[int, float, float]]], list[int], int]:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        feature_collection = json.load(source)
    node_ids: dict[tuple[float, float], int] = {}
    coordinates: list[tuple[float, float]] = []
    adjacency: list[list[tuple[int, float, float]]] = []
    parent: list[int] = []
    size: list[int] = []

    def node_id(raw: list[float]) -> int:
        coordinate = (round(float(raw[0]), 7), round(float(raw[1]), 7))
        existing = node_ids.get(coordinate)
        if existing is not None:
            return existing
        result = len(coordinates)
        node_ids[coordinate] = result
        coordinates.append(coordinate)
        adjacency.append([])
        parent.append(result)
        size.append(1)
        return result

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return
        if size[left_root] < size[right_root]:
            left_root, right_root = right_root, left_root
        parent[right_root] = left_root
        size[left_root] += size[right_root]

    edges = 0
    for feature in feature_collection.get("features", []):
        geometry = feature.get("geometry") or {}
        lines = geometry.get("coordinates", [])
        if geometry.get("type") == "MultiLineString":
            line_groups = lines
        elif geometry.get("type") == "LineString":
            line_groups = [lines]
        else:
            continue
        road_class = str((feature.get("properties") or {}).get("roadClass", "minor"))
        speed = SPEED_MPS.get(road_class, SPEED_MPS["minor"])
        for line in line_groups:
            for raw_left, raw_right in zip(line, line[1:]):
                left, right = node_id(raw_left), node_id(raw_right)
                metres = _distance_m(coordinates[left], coordinates[right])
                if metres <= 0:
                    continue
                seconds = metres / speed
                adjacency[left].append((right, seconds, metres))
                adjacency[right].append((left, seconds, metres))
                union(left, right)
                edges += 1
    roots = [find(node) for node in range(len(coordinates))]
    return coordinates, adjacency, roots, edges


def benchmark_routing(generated_dir: str | Path, samples_per_tile: int = 5) -> dict[str, Any]:
    generated = Path(generated_dir)
    pilot = generated / "pilot"
    demand = json.loads((pilot / "reports" / "pilot-demand.json").read_text(encoding="utf-8"))
    tile_reports = []
    peak_rss_bytes = _rss_bytes()
    started = time.perf_counter()
    for tile_id in demand["pilotTiles"]:
        tile_started = time.perf_counter()
        graph_started = time.perf_counter()
        coordinates, adjacency, roots, edges = _build_graph(pilot / "tiles" / tile_id / "roads.geojson.gz")
        graph_rss_bytes = _rss_bytes()
        peak_rss_bytes = max(peak_rss_bytes, graph_rss_bytes)
        graph_seconds = time.perf_counter() - graph_started
        component_sizes: dict[int, int] = {}
        for root in roots:
            component_sizes[root] = component_sizes.get(root, 0) + 1
        largest_root = max(component_sizes, key=component_sizes.get) if component_sizes else -1
        candidates = [index for index, root in enumerate(roots) if root == largest_root]
        route_times = []
        route_rows = []
        for index in range(samples_per_tile):
            if len(candidates) < 2:
                break
            left = candidates[(index * len(candidates)) // samples_per_tile]
            right = candidates[-1 - ((index * len(candidates)) // samples_per_tile)]
            route_started = time.perf_counter()
            result = _dijkstra(adjacency, left, right)
            elapsed = time.perf_counter() - route_started
            route_times.append(elapsed)
            route_rows.append({
                "origin": coordinates[left],
                "destination": coordinates[right],
                "computeSeconds": round(elapsed, 6),
                "durationSeconds": round(result[0], 3) if result else None,
                "distanceMetres": round(result[1], 3) if result else None,
            })
        tile_reports.append({
            "tileId": tile_id,
            "nodes": len(coordinates),
            "edges": edges,
            "components": len(component_sizes),
            "largestComponentNodes": len(candidates),
            "graphBuildSeconds": round(graph_seconds, 6),
            "graphRssBytes": graph_rss_bytes,
            "routeP50Seconds": round(statistics.median(route_times), 6) if route_times else None,
            "routeMaxSeconds": round(max(route_times), 6) if route_times else None,
            "samples": route_rows,
            "elapsedSeconds": round(time.perf_counter() - tile_started, 6),
        })
        del coordinates, adjacency, roots
    report = {
        "schemaVersion": 1,
        "prototype": True,
        "status": "complete",
        "kind": "generated-road graph feasibility benchmark",
        "speedModelMps": SPEED_MPS,
        "samplesPerTile": samples_per_tile,
        "elapsedSeconds": round(time.perf_counter() - started, 6),
        "peakRssBytes": peak_rss_bytes,
        "tiles": tile_reports,
        "note": "This proves generated-road graph construction and fastest-path queries; production demand enrichment will use the pinned external OSRM cache.",
    }
    write_json(pilot / "reports" / "pilot-routing.json", report)
    return report
