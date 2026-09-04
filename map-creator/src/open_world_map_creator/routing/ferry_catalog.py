"""Extract passenger sailings and connected terminal access from a local OSM PBF.

Only mapped, connected walking access reaches a road; no geometric gap bridging.
Requires the optional `ferries` extra (pyosmium).
"""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import re
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

from .osrm import _haversine_metres


DENIED = {"no", "private", "customers", "delivery", "agricultural", "forestry"}
CAR_HIGHWAYS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
                "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
                "residential", "living_street", "service"}


def passenger_allowed(tags):
    return (tags.get("foot", tags.get("access", "yes")) not in DENIED
            and tags.get("passenger", tags.get("passengers")) != "no"
            and tags.get("cargo") != "only")


def duration_seconds(value):
    if not value:
        return None
    text = str(value).strip()
    if re.fullmatch(r"\d+(?::\d{1,2}){0,2}", text):
        parts = [int(v) for v in text.split(":")]
        result = parts[0] * 60 if len(parts) == 1 else (
            parts[0] * 3600 + parts[1] * 60 if len(parts) == 2 else
            parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60)
        return result if result > 0 else None
    match = re.fullmatch(r"PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?", text)
    if match:
        result = sum(float(v or 0) * m for v, m in zip(match.groups(), (3600, 60, 1)))
        return result if result > 0 else None
    return None


def extract(pbf: Path, base_url: str, output: Path, progress=print):
    import osmium

    ways, relation_tags = {}, {}

    class Relations(osmium.SimpleHandler):
        def relation(self, relation):
            tags = dict(relation.tags)
            if tags.get("route") == "ferry":
                for member in relation.members:
                    if member.type == "w":
                        relation_tags.setdefault(member.ref, []).append(tags)

    progress("[passenger-ferry] reading ferry relations")
    relation_handler = Relations()
    for relation in osmium.FileProcessor(str(pbf), osmium.osm.RELATION).with_filter(
        osmium.filter.TagFilter(("route", "ferry"))
    ):
        relation_handler.relation(relation)

    class Ferries(osmium.SimpleHandler):
        def way(self, way):
            tags = dict(way.tags)
            if tags.get("route") != "ferry":
                return  # relation members can include access roads; never turn them into sailings
            parents = relation_tags.get(way.id, [])
            # Way tags take precedence. Inherit unambiguous passenger access only,
            # never a whole relation duration onto each member way.
            for key in ("foot", "access", "passenger", "passengers", "cargo"):
                values = {p[key] for p in parents if key in p}
                if key not in tags and len(values) == 1:
                    tags[key] = values.pop()
            if passenger_allowed(tags) and len(way.nodes) >= 2:
                ways[way.id] = (tags, [n.ref for n in way.nodes])

    progress("[passenger-ferry] reading passenger ferry ways")
    ferry_handler = Ferries()
    for way in osmium.FileProcessor(str(pbf), osmium.osm.WAY).with_filter(
        osmium.filter.TagFilter(("route", "ferry"))
    ):
        ferry_handler.way(way)
    if not ways:
        raise ValueError("No passenger ferry ways found")
    ferry_nodes = {n for _, nodes in ways.values() for n in nodes}
    endpoints = {n for _, nodes in ways.values() for n in (nodes[0], nodes[-1])}
    highway_ways, road_nodes = {}, set()
    frontier = set(ferry_nodes)

    class Access(osmium.SimpleHandler):
        def way(self, way):
            highway = way.tags.get("highway")
            if not highway or way.id in highway_ways:
                return
            nodes = [n.ref for n in way.nodes]
            if not frontier.intersection(nodes):
                return
            tags = dict(way.tags)
            access = next((tags[k] for k in ("motorcar", "motor_vehicle", "vehicle", "access") if k in tags), "yes")
            drivable = highway in CAR_HIGHWAYS and access not in DENIED
            walkable = passenger_allowed(tags) and (highway not in {"motorway", "motorway_link", "trunk"} or tags.get("foot") == "yes")
            if drivable:
                road_nodes.update(nodes)
            if drivable or walkable:
                highway_ways[way.id] = (nodes, walkable)
                if walkable and not drivable:
                    next_frontier.update(nodes)

    # Bounded topological expansion through terminal paths, stopping at roads.
    for iteration in range(4):
        next_frontier = set()
        progress(f"[passenger-ferry] terminal access scan {iteration + 1}/4")
        access_handler = Access()
        for way in osmium.FileProcessor(str(pbf), osmium.osm.WAY).with_filter(
            osmium.filter.KeyFilter("highway")
        ):
            access_handler.way(way)
        next_frontier -= frontier
        if not next_frontier:
            break
        frontier.update(next_frontier)
    needed = ferry_nodes | {n for nodes, _ in highway_ways.values() for n in nodes}
    locations, blocked = {}, set()

    class Locations(osmium.SimpleHandler):
        def node(self, node):
            if node.id in needed:
                locations[node.id] = (node.location.lon, node.location.lat)
                tags = dict(node.tags)
                if not passenger_allowed(tags):
                    blocked.add(node.id)
                if tags.get("amenity") == "ferry_terminal":
                    endpoints.add(node.id)

    progress(f"[passenger-ferry] reading {len(needed)} selected coordinates")
    location_handler = Locations()
    for node in osmium.FileProcessor(str(pbf), osmium.osm.NODE).with_filter(osmium.filter.IdFilter(needed)):
        location_handler.node(node)
    walking = defaultdict(list)
    for nodes, walkable in highway_ways.values():
        if not walkable:
            continue
        for a, b in zip(nodes, nodes[1:]):
            if a in locations and b in locations and a not in blocked and b not in blocked:
                metres = _haversine_metres(locations[a], locations[b])
                walking[a].append((b, metres))
                walking[b].append((a, metres))
    # Nodes shared with a highway can be terminals in the middle of a ferry way.
    endpoints.update(ferry_nodes.intersection(road_nodes | set(walking)))
    ports, diagnostics = [], Counter()
    for node in sorted(endpoints):
        if node not in locations or node in blocked:
            continue
        queue, best = [(0., node)], {node: 0.}
        road_node, walked = None, None
        while queue:
            distance, current = heapq.heappop(queue)
            if distance != best[current] or distance > 1500:
                continue
            if current in road_nodes:
                road_node, walked = current, distance
                break
            for neighbor, metres in walking.get(current, []):
                candidate = distance + metres
                if candidate < best.get(neighbor, math.inf):
                    best[neighbor] = candidate
                    heapq.heappush(queue, (candidate, neighbor))
        if road_node is None:
            diagnostics["noConnectedRoadAccess"] += 1
            continue
        lon, lat = locations[road_node]
        url = f"{base_url.rstrip('/')}/nearest/v1/driving/{lon},{lat}?number=1"
        with urllib.request.urlopen(url, timeout=60) as response:
            payload = json.load(response)
        if payload.get("code") != "Ok":
            raise RuntimeError(f"OSRM nearest failed: {payload.get('code')}")
        waypoint = payload["waypoints"][0]
        # Require the mapped road itself to exist in OSRM, not a distant substitute.
        if waypoint["distance"] > 20:
            diagnostics["roadSnapRejected"] += 1
            continue
        ports.append({"node": str(node), "location": locations[node],
                      "roadLocation": waypoint["location"],
                      "accessMetres": walked + waypoint["distance"]})
    edges = []
    for way_id, (tags, nodes) in sorted(ways.items()):
        if any(n not in locations for n in nodes):
            diagnostics["incompleteWays"] += 1
            continue
        lengths = [_haversine_metres(locations[a], locations[b]) for a, b in zip(nodes, nodes[1:])]
        duration = duration_seconds(tags.get("duration"))
        total = sum(lengths)
        direction = tags.get("oneway:foot", tags.get("oneway", "no"))
        for a, b, metres in zip(nodes, nodes[1:], lengths):
            edge = {"from": str(a), "to": str(b), "metres": metres,
                    "seconds": duration * metres / total if duration else metres / (5 / 3.6),
                    "osmWayId": way_id, "durationSource": "osm-duration" if duration else "estimated-5-kmh"}
            if direction != "-1":
                edges.append(edge)
            if direction not in {"yes", "1", "true"}:
                edges.append({**edge, "from": str(b), "to": str(a)})
        diagnostics["waysWithDuration" if duration else "waysWithEstimatedDuration"] += 1
    diagnostics.update({"ports": len(ports), "directedEdges": len(edges), "ways": len(ways)})
    with pbf.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    result = {"schemaVersion": 1, "sourceSha256": digest, "ports": ports, "edges": edges,
              "report": dict(diagnostics), "terminalAccess": "mapped walking paths, max 1500m; road snap max 20m"}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, sort_keys=True), encoding="utf-8")
    temporary.replace(output)
    progress(f"[passenger-ferry] catalog ready: {dict(diagnostics)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--osrm-base-url", default="http://127.0.0.1:5000")
    args = parser.parse_args()
    extract(args.pbf, args.osrm_base_url, args.output, lambda message: print(message, flush=True))


if __name__ == "__main__":
    main()
