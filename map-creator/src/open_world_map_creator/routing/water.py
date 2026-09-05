"""Opt-in, synthetic straight-water fallback after roads and mapped ferries.

Land is never inferred from the display tile boundaries. The supplied WGS84
land mask must include all intervening islands and preserve inland-water holes.
"""
from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from pathlib import Path

import shapely
from pyproj import Geod, Transformer
from shapely.geometry import LineString, Point, shape
from shapely.ops import nearest_points, transform

from .generated_roads import RouteResult


WATER_VERSION = "straight-water-v1"
WATER_SPEED_KPH = 5.0
ACCESS_SPEED_MPS = 1.4
GEOD = Geod(ellps="WGS84")


class LandMask:
    def __init__(self, raw: bytes):
        data = json.loads(raw)
        if data.get("crs", {}).get("properties", {}).get("name") not in (
            None, "EPSG:4326", "urn:ogc:def:crs:OGC:1.3:CRS84",
            "urn:ogc:def:crs:EPSG::4326",
        ):
            raise ValueError("Water land mask must use WGS84 longitude/latitude")
        features = data["features"] if data["type"] == "FeatureCollection" else [data]
        if any(f.get("properties", {}).get("inland_water_policy") == "filled"
               or f.get("properties", {}).get("minimum_island_area_km2", 0) > 0
               for f in features):
            raise ValueError("Display boundaries with filled water/removed islands are not a land mask")
        geometries = [shape(f["geometry"] if f["type"] == "Feature" else f) for f in features]
        if not geometries or any(g.is_empty or g.geom_type not in {"Polygon", "MultiPolygon"}
                                 or not g.is_valid for g in geometries):
            raise ValueError("Water land mask requires nonempty, valid polygons")
        bounds = shapely.total_bounds(geometries)
        x0, y0, x1, y1 = bounds
        if not all(math.isfinite(v) for v in bounds) or not (-180 <= x0 <= x1 <= 180
                and -85 < y0 <= y1 < 85) or x1 - x0 > 180:
            raise ValueError("Water mask must be a regional WGS84 dataset, not cross the dateline")
        # A regional metric plane defines straight crossings and nearest shores;
        # actual distances are measured geodesically, not in Web Mercator metres.
        crs = f"+proj=aeqd +lat_0={(y0+y1)/2} +lon_0={(x0+x1)/2} +datum=WGS84 +units=m"
        self.forward = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self.inverse = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        projected = [transform(self.forward.transform, g) for g in geometries]
        # Our physical-mask compiler already dissolved shared coast fragments
        # before subtracting water. Do not repeat a national union for every
        # routing run; generic input masks still need that normalization.
        if data.get("purpose") == "physical-land-computation":
            self.parts = [part for g in projected for part in shapely.get_parts(g)]
        else:
            self.parts = list(shapely.get_parts(shapely.union_all(projected)))
        shapely.prepare(self.parts)
        self.tree = shapely.STRtree(self.parts)
        self.crs = crs

    def point(self, coordinate):
        return Point(self.forward.transform(*coordinate))

    def coordinate(self, point):
        return tuple(self.inverse.transform(point.x, point.y))

    def metres(self, a, b):
        if a.equals(b):
            return 0.0
        return abs(GEOD.inv(*self.coordinate(a), *self.coordinate(b))[2])

    def owner(self, point):
        for i in self.tree.query(point):
            if self.parts[i].covers(point):
                return int(i)
        return None

    def plan(self, origin, destination):
        """Greedy land exit nearest final destination, then first land on ray.

        Re-aim after each island instead of pretending that intervening land is
        water. Fail closed if the geometry cannot make forward progress.
        """
        current, target = self.point(origin), self.point(destination)
        owner, target_owner = self.owner(current), self.owner(target)
        if owner is None or target_owner is None:
            return None, "endpoint-outside-land-mask"
        segments, visited = [], set()
        for _ in range(256):
            if owner == target_owner:
                segments.append(("land", current, target, owner))
                return (segments, None) if any(s[0] == "water" for s in segments) else (None, "same-landmass")
            if owner in visited:
                return None, "land-cycle"
            visited.add(owner)
            shore = nearest_points(self.parts[owner], target)[0]
            segments.append(("land", current, shore, owner))
            ray = LineString([shore, target])
            hits = []
            for i in self.tree.query(ray):
                if i == owner:
                    continue
                intersection = self.parts[i].intersection(ray)
                if intersection.is_empty:
                    continue
                entry = nearest_points(shore, intersection)[1]
                offset = ray.project(entry)
                if offset > 0.01:
                    hits.append((offset, int(i), entry))
            if not hits:
                return None, "no-landfall"
            _, next_owner, entry = min(hits, key=lambda hit: (hit[0], hit[1]))
            if entry.distance(target) >= current.distance(target) - 0.01:
                return None, "no-forward-progress"
            segments.append(("water", shore, entry, None))
            current, owner = entry, next_owner
        return None, "landfall-limit"


class StraightWaterRouter:
    # Every actual cross endpoint must be inspected: a sampled island cohort
    # cannot stand in for mainland cohorts in the same prefecture pair.
    requires_exact_cross_routes = True

    def __init__(self, backend, road, land_path: Path, max_access_metres=1500.0):
        if not math.isfinite(max_access_metres) or max_access_metres <= 0:
            raise ValueError("Water shoreline access limit must be positive and finite")
        self.backend, self.road = backend, road
        self.raw = land_path.read_bytes()
        self.land = None  # Avoid loading/projecting a large mask unless needed.
        self.max_access_metres = max_access_metres
        self.identity = hashlib.sha256(self.raw + json.dumps(
            [WATER_VERSION, WATER_SPEED_KPH, ACCESS_SPEED_MPS, max_access_metres]
        ).encode()).hexdigest()
        self.connection = road.cache.connection
        self.connection.execute("CREATE TABLE IF NOT EXISTS straight_water_cache "
                                "(cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL)")
        self.connection.commit()
        self.stats = Counter()
        self.access = {}

    @property
    def input_fingerprint(self):
        return {**self.backend.input_fingerprint, "straightWater": self.identity}

    def driving_model(self):
        model = self.backend.driving_model()
        return {**model, "graphVersion": f"{model['graphVersion']}:{WATER_VERSION}:{self.identity[:16]}",
                "straightWater": {"version": WATER_VERSION, "landMaskId": self.identity,
                    "waterSpeedKph": WATER_SPEED_KPH, "shoreAccessSpeedMps": ACCESS_SPEED_MPS,
                    "maxShoreAccessMetres": self.max_access_metres,
                    "synthetic": True, "transferSeconds": 0,
                    "costModel": "existing game driving-distance cost; not a real ferry service"}}

    def report(self):
        return {**self.backend.report(), "straightWater": dict(self.stats), "waterLandMaskId": self.identity}

    def close(self):
        self.backend.close()

    def _access(self, point, owner):
        key = (point.x, point.y, owner)
        if key not in self.access:
            land = self.land.parts[owner]
            accepted = []
            for candidate in self.road.nearest_candidates(self.land.coordinate(point)):
                coordinate = tuple(candidate["location"])
                snapped = self.land.point(coordinate)
                metres = self.land.metres(point, snapped)
                # Never let OSRM nearest silently jump across a channel or river.
                connector = LineString([point, snapped]) if metres > 0 else point
                # Intersection/inverse-projection roundoff can put a shoreline
                # point micrometres outside its polygon. Permit only 1 mm of
                # numerical error, not a buffer that could bridge real water.
                if (metres <= self.max_access_metres and (land.covers(connector)
                        or (land.distance(snapped) <= .001 and connector.difference(land).length <= .001))):
                    accepted.append((coordinate, metres))
            self.access[key] = accepted
        return self.access[key]

    def _land_leg(self, start, end, owner, options):
        if start.distance(end) < 0.01:
            return {"mode": "land", "seconds": 0, "metres": 0, "accessMetres": 0}
        starts, ends = self._access(start, owner), self._access(end, owner)
        requests = [((i, j), a, b) for i, (a, _) in enumerate(starts)
                    for j, (b, _) in enumerate(ends)]
        routes = self.road.route_pairs(requests, progress=lambda _: None, **options)
        choices = []
        for (i, j), route in routes.items():
            if route.source != "osrm":
                continue
            access = starts[i][1] + ends[j][1]
            choices.append({"mode": "land", "seconds": route.seconds + access / ACCESS_SPEED_MPS,
                            "metres": route.metres + access, "roadSeconds": route.seconds,
                            "roadMetres": route.metres, "accessMetres": access,
                            "roadFrom": starts[i][0], "roadTo": ends[j][0]})
        return min(choices, key=lambda s: (s["seconds"], s["metres"])) if choices else None

    def _route(self, origin, destination, options, progress):
        if self.land is None:
            progress("[straight-water] loading full-detail land geometry")
            self.land = LandMask(self.raw)
        plan, reason = self.land.plan(origin, destination)
        if plan is None:
            return {"status": "unresolved", "reason": reason}
        segments = []
        for index, (mode, start, end, owner) in enumerate(plan):
            if mode == "water":
                metres = self.land.metres(start, end)
                segment = {"mode": "water", "metres": metres, "seconds": metres / (WATER_SPEED_KPH / 3.6)}
            else:
                progress(f"[straight-water] road leg {index+1}/{len(plan)}")
                segment = self._land_leg(start, end, owner, options)
                if segment is None:
                    return {"status": "unresolved", "reason": "no-reachable-land-road",
                            "landFrom": self.land.coordinate(start), "landTo": self.land.coordinate(end)}
            segments.append({**segment, "from": self.land.coordinate(start), "to": self.land.coordinate(end)})
        return {"status": "resolved", "source": "osrm-straight-water",
                "seconds": max(60, round(sum(s["seconds"] for s in segments))),
                "metres": max(1, round(sum(s["metres"] for s in segments))), "segments": segments}

    def route_pairs(self, requests, *, progress=print, **options):
        requests = list(requests)
        result = self.backend.route_pairs(requests, progress=progress, **options)
        failed = [row for row in requests if result[row[0]].source == "osrm-no-route-fallback"]
        if failed:
            progress(f"[straight-water] checking {len(failed)} remaining disconnected pairs")
        for index, (key, origin, destination) in enumerate(failed):
            cache_key = hashlib.sha256(json.dumps(
                [self.input_fingerprint, origin, destination, options], sort_keys=True
            ).encode()).hexdigest()
            cached = self.connection.execute("SELECT result_json FROM straight_water_cache WHERE cache_key=?",
                                             (cache_key,)).fetchone()
            if cached:
                value = json.loads(cached[0])
                self.stats["cacheHits"] += 1
            else:
                value = self._route(origin, destination, options, progress)
                value.update(origin=origin, destination=destination, policyId=self.identity)
                self.connection.execute("INSERT INTO straight_water_cache VALUES (?, ?)",
                                        (cache_key, json.dumps(value)))
                self.connection.commit()
                self.stats["computedPairs"] += 1
            self.stats[value["status"]] += 1
            if value["status"] == "resolved":
                result[key] = RouteResult(value["seconds"], value["metres"], value["source"], 0)
            else:
                self.stats[value["reason"]] += 1
            if index % 25 == 0 or index + 1 == len(failed):
                progress(f"[straight-water] pairs {index+1}/{len(failed)}; {dict(self.stats)}")
        return result

    def route(self, origin, destination, **options):
        return self.route_pairs([(0, origin, destination)], **options)[0]
