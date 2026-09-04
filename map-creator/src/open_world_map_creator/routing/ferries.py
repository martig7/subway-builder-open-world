"""Passenger ferry overlay: OSRM access legs plus mapped sailings.

The road cache is authoritative and unchanged. Only NoRoute pairs enter this
overlay, whose own cache includes the catalog and transfer policy identities.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
import itertools
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .generated_roads import RouteResult


FERRY_VERSION = "passenger-ferry-v1"


class PassengerFerryRouter:
    def __init__(self, road: Any, catalog_path: Path, transfer_seconds: float = 300) -> None:
        if not math.isfinite(transfer_seconds) or transfer_seconds < 0:
            raise ValueError("Ferry transfer seconds must be finite and nonnegative")
        self.road = road
        raw = catalog_path.read_bytes()
        self.catalog = json.loads(raw)
        if self.catalog.get("schemaVersion") != 1:
            raise ValueError("Unsupported passenger ferry catalog")
        self.transfer_seconds = transfer_seconds
        self.identity = hashlib.sha256(
            raw + f"{FERRY_VERSION}:{transfer_seconds}".encode()
        ).hexdigest()
        self.stats: Counter = Counter()
        self.graph = None
        self.ports = self.catalog["ports"]
        self.connection = road.cache.connection
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS passenger_ferry_cache "
            "(cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL)"
        )
        self.connection.commit()

    @property
    def input_fingerprint(self):
        return {**self.road.input_fingerprint, "passengerFerry": self.identity}

    def driving_model(self):
        return {**self.road.driving_model(),
                "graphVersion": f"{self.road.driving_model()['graphVersion']}:{FERRY_VERSION}:{self.identity[:16]}",
                "passengerFerry": {
            "version": FERRY_VERSION, "catalogId": self.identity,
            "transferSeconds": self.transfer_seconds,
            "scheduleWaitSeconds": 0,
            "costModel": "existing distance-based game cost; ferry fares not supplied",
        }}

    def report(self):
        return {**self.road.report(), "passengerFerry": dict(self.stats),
                "ferryCatalogId": self.identity}

    def close(self):
        self.road.close()

    def _roads(self, requests, options, progress):
        # Real OSRM paths only. The fallback values are never accepted as legs.
        return self.road.route_pairs(requests, **options, progress=progress)

    def _prepare(self, options, progress):
        if self.graph is not None:
            return
        graph = defaultdict(list)
        for edge in self.catalog["edges"]:
            seconds, metres = float(edge["seconds"]), float(edge["metres"])
            if not math.isfinite(seconds) or seconds <= 0 or not math.isfinite(metres) or metres <= 0:
                raise ValueError("Ferry edges require positive finite time and distance")
            graph[edge["from"]].append((edge["to"], seconds, {
                "mode": "ferry", "seconds": seconds, "metres": metres,
                "osmWayId": edge.get("osmWayId"),
                "durationSource": edge.get("durationSource"),
            }))
        progress(f"[passenger-ferry] connecting {len(self.ports)} ports by cached OSRM roads")
        # Road-to-road transfers allow ferry chains with an overland connection.
        # Each departure from a ferry incurs the configured transfer once.
        for a, port_a in enumerate(self.ports):
            requests = [((a, b), tuple(port_a["roadLocation"]), tuple(port_b["roadLocation"]))
                        for b, port_b in enumerate(self.ports) if a != b]
            routes = self._roads(requests, options, lambda _: None)
            for (_, b), route in routes.items():
                if route.source != "osrm":
                    continue
                port_b = self.ports[b]
                access = port_a["accessMetres"] + port_b["accessMetres"]
                seconds = route.seconds + access / 1.4 + self.transfer_seconds
                graph[port_a["node"]].append((port_b["node"], seconds, {
                    "mode": "rideshare", "seconds": route.seconds,
                    "metres": route.metres, "accessMetres": access,
                    "transferSeconds": self.transfer_seconds,
                }))
            if a % 25 == 0 or a + 1 == len(self.ports):
                progress(f"[passenger-ferry] port road connections {a + 1}/{len(self.ports)}")
        self.graph = graph

    def _route(self, origin, destination, options, progress):
        access_requests = []
        for i, port in enumerate(self.ports):
            location = tuple(port["roadLocation"])
            access_requests.extend([(("start", i), origin, location),
                                    (("end", i), location, destination)])
        roads = self._roads(access_requests, options, lambda _: None)
        starts, ends = {}, {}
        for i, port in enumerate(self.ports):
            for side, target in (("start", starts), ("end", ends)):
                route = roads[(side, i)]
                if route.source == "osrm":
                    transfer = self.transfer_seconds if side == "end" else 0
                    segment = {"mode": "drive" if side == "start" else "rideshare",
                               "seconds": route.seconds, "metres": route.metres,
                               "accessMetres": port["accessMetres"], "transferSeconds": transfer}
                    target[port["node"]] = (route.seconds + port["accessMetres"] / 1.4 + transfer, segment)
        if not starts or not ends:
            return None
        best, previous, queue = {}, {}, []
        # Track whether an actual sailing has been used, including zero road legs.
        for node, (seconds, segment) in starts.items():
            state = (node, False)
            best[state] = seconds
            previous[state] = (None, segment)
            heapq.heappush(queue, (seconds, state))
        winner, total = None, math.inf
        while queue:
            elapsed, state = heapq.heappop(queue)
            if elapsed != best[state] or elapsed >= total:
                continue
            node, sailed = state
            if sailed and node in ends and elapsed + ends[node][0] < total:
                winner, total = state, elapsed + ends[node][0]
            for neighbor, seconds, segment in self.graph.get(node, []):
                next_state = (neighbor, sailed or segment["mode"] == "ferry")
                candidate = elapsed + seconds
                if candidate < best.get(next_state, math.inf):
                    best[next_state] = candidate
                    previous[next_state] = (state, segment)
                    heapq.heappush(queue, (candidate, next_state))
        if winner is None:
            return None
        segments = [ends[winner[0]][1]]
        state = winner
        while state is not None:
            state, segment = previous[state]
            segments.append(segment)
        segments.reverse()
        return {"seconds": max(60, round(total)),
                "metres": max(1, round(sum(s["metres"] + s.get("accessMetres", 0) for s in segments))),
                "source": "osrm-passenger-ferry", "segments": segments}

    def route_pairs(self, requests, *, progress=print, **options):
        requests = list(requests)
        result = self.road.route_pairs(requests, progress=progress, **options)
        failed = [(key, origin, destination) for key, origin, destination in requests
                  if result[key].source == "osrm-no-route-fallback"]
        if failed:
            progress(f"[passenger-ferry] checking {len(failed)} disconnected pairs")
        pending = []
        for key, origin, destination in failed:
            cache_key = hashlib.sha256(json.dumps(
                [self.identity, self.road.input_fingerprint, origin, destination, options], sort_keys=True
            ).encode()).hexdigest()
            cached = self.connection.execute(
                "SELECT result_json FROM passenger_ferry_cache WHERE cache_key=?", (cache_key,)
            ).fetchone()
            if cached:
                value = json.loads(cached[0])
                self.stats["cacheHits"] += 1
            else:
                pending.append((key, origin, destination, cache_key))
                continue
            if value:
                result[key] = RouteResult(value["seconds"], value["metres"], value["source"], 0)
                self.stats["resolved"] += 1
            else:
                self.stats["unresolved"] += 1
        if pending:
            self._prepare(options, progress)
            origins = sorted({tuple(row[1]) for row in pending})
            destinations = sorted({tuple(row[2]) for row in pending})
            ports = [tuple(p["roadLocation"]) for p in self.ports]
            # Group both directions by origin for OSRM one-to-many tables.
            # In particular, query each port against ALL job points together.
            pairs = itertools.chain(itertools.product(origins, ports), itertools.product(ports, destinations))
            warmed = 0
            while chunk := list(itertools.islice(pairs, 25000)):
                self._roads(((i, a, b) for i, (a, b) in enumerate(chunk)), options, progress)
                warmed += len(chunk)
                progress(f"[passenger-ferry] access legs cached {warmed}")
        for index, (key, origin, destination, cache_key) in enumerate(pending):
            value = self._route(origin, destination, options, progress)
            self.connection.execute("INSERT OR REPLACE INTO passenger_ferry_cache VALUES (?, ?)",
                                    (cache_key, json.dumps(value)))
            self.connection.commit()
            self.stats["computedPairs"] += 1
            if value:
                result[key] = RouteResult(value["seconds"], value["metres"], value["source"], 0)
                self.stats["resolved"] += 1
            else:
                self.stats["unresolved"] += 1
            if index % 25 == 0 or index + 1 == len(pending):
                progress(f"[passenger-ferry] pairs {index + 1}/{len(pending)}; {dict(self.stats)}")
        return result

    def route(self, origin, destination, **options):
        return self.route_pairs([(0, origin, destination)], **options)[0]
