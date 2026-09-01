#!/usr/bin/env python3
"""Compile e-Stat demand plus OSM building seeds into a two-city mod contract.

The two city packages cover mainland Tokyo and Kanagawa. Tokyo's remote island
municipalities remain in the source data but are excluded from this first road
package: a single rectangular OSM/PMTiles extent would be almost 2,000 km wide.
Final demand sites use NEC-style maximal-radius merging and are snapped to a
member building center rather than left at regular census-mesh centroids.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from shapely import make_valid
from shapely.geometry import Point, shape

from building_seed_voronoi import build_tile_sites


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT.parent / "japan" / "generated" / "tokyo-kanagawa-test"
GENERATED = ROOT / "generated"
TILES = (
    {
        "id": "JP_TOKYO_MAINLAND", "gameCityCode": "JP_TOKYO_MAINLAND", "prefCode": "13",
        "name": "Tokyo", "bounds": [138.95, 35.35, 140.05, 36.05],
        "initialView": {"longitude": 139.7671, "latitude": 35.6812, "zoom": 11.2, "bearing": 0},
    },
    {
        "id": "JP_KANAGAWA_MAINLAND", "gameCityCode": "JP_KANAGAWA_MAINLAND", "prefCode": "14",
        "name": "Kanagawa", "bounds": [138.85, 35.05, 139.95, 35.75],
        "initialView": {"longitude": 139.6380, "latitude": 35.4478, "zoom": 11.0, "bearing": 0},
    },
)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
            output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def chunks(mass: int, minimum: int = 50, maximum: int = 200) -> list[int]:
    if mass <= 0:
        return []
    count = max(1, math.ceil(mass / maximum))
    while count > 1 and mass // count < minimum:
        count -= 1
    base, remainder = divmod(mass, count)
    return [base + (1 if index < remainder else 0) for index in range(count)]


def stable_index(seed: str, size: int) -> int:
    return int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16], 16) % size


def weighted_pick(rows: list[dict[str, Any]], seed: str, weight_field: str = "weight") -> dict[str, Any]:
    positive = [row for row in rows if int(row[weight_field]) > 0]
    total = sum(int(row[weight_field]) for row in positive)
    target = stable_index(seed, total)
    for row in positive:
        target -= int(row[weight_field])
        if target < 0:
            return row
    return positive[-1]


def proportional_allocations(rows: list[dict[str, Any]], total: int, weight_field: str) -> dict[str, int]:
    weight_total = sum(int(row[weight_field]) for row in rows)
    if total < 0 or weight_total <= 0:
        raise ValueError(f"Cannot allocate {total} from {weight_field} total {weight_total}")
    allocations: dict[str, int] = {}
    remainders = []
    assigned = 0
    for row in rows:
        amount, remainder = divmod(total * int(row[weight_field]), weight_total)
        allocations[row["id"]] = amount
        assigned += amount
        remainders.append((remainder, row["id"]))
    for _, site_id in sorted(remainders, key=lambda item: (-item[0], item[1]))[: total - assigned]:
        allocations[site_id] += 1
    if sum(allocations.values()) != total:
        raise AssertionError(f"{weight_field} allocation did not conserve {total}")
    return allocations


def tile_catalog() -> dict[str, Any]:
    tiles = []
    for tile in TILES:
        other = next(candidate for candidate in TILES if candidate["id"] != tile["id"])
        tiles.append({
            **tile, "status": "selected", "population": 0,
            "haloBounds": tile["bounds"],
            "neighbors": [{"tileId": other["id"], "direction": "cross-prefecture"}],
        })
    return {
        "schemaVersion": 1, "worldId": "JP_TOKYO_KANAGAWA_MAINLAND", "prototype": True,
        "name": "Tokyo–Kanagawa Open World", "initialView": TILES[0]["initialView"], "tiles": tiles,
        "scope": "Tokyo and Kanagawa mainland; remote Tokyo islands are deferred streaming tiles",
    }


def main() -> None:
    boundary = read_json(SOURCE / "world-boundary.geojson")
    prefectures = {feature["properties"]["pref_code"]: make_valid(shape(feature["geometry"])) for feature in boundary["features"]}
    home_features = read_json(SOURCE / "home-mesh-250m.geojson")["features"]
    job_features = read_json(SOURCE / "job-mesh-500m.geojson")["features"]
    cells_by_tile: dict[str, list[dict[str, Any]]] = {tile["id"]: [] for tile in TILES}
    jobs_by_tile: dict[str, list[dict[str, Any]]] = {tile["id"]: [] for tile in TILES}
    excluded = 0
    for feature in home_features:
        longitude, latitude = feature["geometry"]["coordinates"]
        point = Point(longitude, latitude)
        source_prefecture = feature["properties"].get("prefCode")
        tile = next((candidate for candidate in TILES if (source_prefecture == candidate["prefCode"] if source_prefecture else prefectures[candidate["prefCode"]].covers(point)) and candidate["bounds"][0] <= longitude <= candidate["bounds"][2] and candidate["bounds"][1] <= latitude <= candidate["bounds"][3]), None)
        if tile is None:
            excluded += 1
            continue
        properties = feature["properties"]
        cells_by_tile[tile["id"]].append({
            "id": properties["id"],
            "meshCode": properties["meshCode"],
            "longitude": float(longitude),
            "latitude": float(latitude),
            "commuters": int(properties["commuters"]),
        })
    for feature in job_features:
        longitude, latitude = feature["geometry"]["coordinates"]
        point = Point(longitude, latitude)
        source_prefecture = feature["properties"].get("prefCode")
        tile = next((candidate for candidate in TILES if (source_prefecture == candidate["prefCode"] if source_prefecture else prefectures[candidate["prefCode"]].covers(point)) and candidate["bounds"][0] <= longitude <= candidate["bounds"][2] and candidate["bounds"][1] <= latitude <= candidate["bounds"][3]), None)
        if tile is None:
            continue
        properties = feature["properties"]
        jobs_by_tile[tile["id"]].append({
            "id": properties["id"],
            "meshCode": properties["meshCode"],
            "longitude": float(longitude),
            "latitude": float(latitude),
            "jobs": int(properties["jobs"]),
        })
    by_tile: dict[str, list[dict[str, Any]]] = {}
    site_geometry_reports: dict[str, dict[str, Any]] = {}
    for tile in TILES:
        tile_id = tile["id"]
        sites, geometry_report = build_tile_sites(
            tile_id,
            cells_by_tile[tile_id],
            jobs_by_tile[tile_id],
            GENERATED / "maps" / "tiles" / tile_id / "buildings_index.bin.gz",
            tile["bounds"],
            prefectures[tile["prefCode"]],
        )
        by_tile[tile_id] = sites
        site_geometry_reports[tile_id] = geometry_report
    if any(not rows for rows in by_tile.values()):
        raise ValueError("Each mainland tile must receive demand sites")

    flows = read_json(SOURCE / "municipality-od.json")["flows"]
    cross_mass: dict[tuple[str, str], int] = defaultdict(int)
    for flow in flows:
        origin, destination = flow["originMunicipalityCode"][:2], flow["destinationMunicipalityCode"][:2]
        if origin in {"13", "14"} and destination in {"13", "14"} and origin != destination:
            cross_mass[(origin, destination)] += int(flow["commutersAndStudents"])
    tile_for_pref = {tile["prefCode"]: tile for tile in TILES}
    local_mass: dict[str, int] = {}
    for tile in TILES:
        total = sum(site["commuters"] for site in by_tile[tile["id"]])
        local_mass[tile["id"]] = max(0, total - sum(cross_mass[(tile["prefCode"], other)] for other in tile_for_pref if other != tile["prefCode"]))

    catalog = tile_catalog()
    write_json(GENERATED / "catalog" / "tokyo-kanagawa-tile-catalog.json", catalog)
    cross_points: dict[str, dict[str, Any]] = {}
    cross_pops: list[dict[str, Any]] = []
    commute_buckets: list[dict[str, Any]] = []
    for (origin_pref, destination_pref), mass in sorted(cross_mass.items()):
        origin_tile, destination_tile = tile_for_pref[origin_pref], tile_for_pref[destination_pref]
        origin_sites, destination_sites = by_tile[origin_tile["id"]], by_tile[destination_tile["id"]]
        cohort_masses = chunks(mass)
        for index, cohort_mass in enumerate(cohort_masses):
            home = weighted_pick(origin_sites, f"cross-home:{origin_pref}:{destination_pref}:{index}", "commuters")
            work = weighted_pick(destination_sites, f"cross-work:{origin_pref}:{destination_pref}:{index}", "jobs")
            for role, site in (("residents", home), ("workers", work)):
                point = cross_points.setdefault(site["id"], {"id": site["id"], "longitude": site["location"][0], "latitude": site["location"][1], "tileId": origin_tile["id"] if role == "residents" else destination_tile["id"], "residents": 0, "workers": 0})
                point[role] += cohort_mass
            cross_pops.append({"id": f"jp-tk-cross-{origin_pref}-{destination_pref}-{index:05d}", "mass": cohort_mass, "home": home["id"], "work": work["id"], "homeTileId": origin_tile["id"], "workTileId": destination_tile["id"], "gateway": "tokyo-kanagawa-prefecture-boundary", "homeDepartureTime": "07:30", "workDepartureTime": "17:30", "drivingSeconds": 1800, "drivingDistance": 18000})
        commute_buckets.append({"id": f"jp-tk-{origin_pref}-{destination_pref}", "homeTileId": origin_tile["id"], "workTileId": destination_tile["id"], "gatewayId": "tokyo-kanagawa-prefecture-boundary", "mass": mass, "defaultTravelSeconds": 1800, "defaultCapacityPerHour": 100000})

    point_ids = sorted(cross_points)
    point_index = {point_id: index for index, point_id in enumerate(point_ids)}
    cross_demand = {
        "schemaVersion": 1, "tileId": None,
        "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
        "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance"],
        "drivingModel": {"provider": "synthetic", "label": "municipality O/D constrained test allocation"},
        "gateways": ["tokyo-kanagawa-prefecture-boundary"],
        "points": [[cross_points[key][field] for field in ("id", "longitude", "latitude", "tileId", "residents", "workers")] for key in point_ids],
        "pops": [[row["id"], row["mass"], point_index[row["home"]], point_index[row["work"]], 0, row["homeDepartureTime"], row["workDepartureTime"], row["drivingSeconds"], row["drivingDistance"]] for row in cross_pops],
    }
    commute_catalog = {"schemaVersion": 1, "buildHash": "jp-tk-municipality-od-v1", "buckets": commute_buckets, "gateways": [{"id": "tokyo-kanagawa-prefecture-boundary", "location": [139.645, 35.475], "capacityPerHour": 100000}]}
    gzip_json(GENERATED / "demand" / "world" / "cross_demand.json.gz", cross_demand)
    write_json(GENERATED / "demand" / "world" / "cross_commutes.json", commute_catalog)

    report_tiles = []
    for tile in TILES:
        sites = by_tile[tile["id"]]
        retained_local = local_mass[tile["id"]]
        home_allocations = proportional_allocations(sites, retained_local, "commuters")
        job_allocations = proportional_allocations(sites, retained_local, "jobs")
        site_by_id = {site["id"]: site for site in sites}
        point_map = {
            site["id"]: {
                "id": site["id"], "location": site["location"],
                "jobs": job_allocations[site["id"]], "residents": home_allocations[site["id"]], "popIds": [],
            }
            for site in sites
            if home_allocations[site["id"]] > 0 or job_allocations[site["id"]] > 0
        }
        home_rows = [[site_id, amount] for site_id, amount in sorted(home_allocations.items()) if amount > 0]
        job_rows = [[site_id, amount] for site_id, amount in sorted(job_allocations.items()) if amount > 0]
        pops = []
        home_index = job_index = 0
        while home_index < len(home_rows) and job_index < len(job_rows):
            home_id, home_remaining = home_rows[home_index]
            job_id, job_remaining = job_rows[job_index]
            flow = min(home_remaining, job_remaining)
            for part, size in enumerate(chunks(flow)):
                pop_id = f"jp-tk-local-{tile['id'].lower()}-{home_id}-{job_id}-{part}"
                home_location, job_location = site_by_id[home_id]["location"], site_by_id[job_id]["location"]
                mean_latitude = math.radians((home_location[1] + job_location[1]) / 2)
                dx = (home_location[0] - job_location[0]) * 111_320 * math.cos(mean_latitude)
                dy = (home_location[1] - job_location[1]) * 110_574
                distance = max(1, round(math.hypot(dx, dy)))
                pops.append({"id": pop_id, "size": size, "residenceId": home_id, "jobId": job_id, "drivingSeconds": max(60, round(distance / 13.4)), "drivingDistance": distance})
                point_map[home_id]["popIds"].append(pop_id)
                if job_id != home_id:
                    point_map[job_id]["popIds"].append(pop_id)
            home_rows[home_index][1] -= flow
            job_rows[job_index][1] -= flow
            if home_rows[home_index][1] == 0:
                home_index += 1
            if job_rows[job_index][1] == 0:
                job_index += 1
        if home_index != len(home_rows) or job_index != len(job_rows):
            raise AssertionError(f"{tile['id']} local home/job transport did not conserve mass")
        points = [point_map[key] for key in sorted(point_map)]
        tile_dir = GENERATED / "demand" / "tiles" / tile["id"]
        gzip_json(tile_dir / "demand_data.json.gz", {"points": points, "pops": pops})
        write_json(tile_dir / "cross_commutes.json", {**commute_catalog, "tileId": tile["id"]})
        gzip_json(tile_dir / "cross_demand.json.gz", {**cross_demand, "tileId": tile["id"]})
        write_json(tile_dir / "manifest.json", {"schemaVersion": 1, "tileId": tile["id"], "cityCode": tile["gameCityCode"], "dataFiles": {"demandData": "demand_data.json.gz"}})
        report_tiles.append({
            "tileId": tile["id"], "siteCount": len(sites), "localWorkers": retained_local,
            "cohortCount": len(pops), **site_geometry_reports[tile["id"]],
        })
    aggregation = {
        "sourceMeshM": 250,
        "fineSeedSource": "osm-building-index-v1",
        "buildingIndexCellDegrees": sorted({row["buildingIndexCellDegrees"] for row in site_geometry_reports.values()}),
        "pointMergeDistanceM": 350,
        "finalSiteAnchor": "member-building-center",
        "unanchoredSiteCount": sum(row["unanchoredSiteCount"] for row in site_geometry_reports.values()),
        "algorithm": "NEC deterministic maximal-radius Voronoi merge over building-level fine seeds",
    }
    report = {
        "schemaVersion": 1, "worldId": catalog["worldId"], "tiles": report_tiles,
        "aggregation": aggregation,
        "crossPrefectureWorkers": sum(cross_mass.values()),
        "excludedRemoteIslandCells": excluded,
        "limitations": ["Within-prefecture origins and destinations are deterministically matched from separate home/job marginals; municipal O/D controls are retained for the next spatial allocator."],
    }
    write_json(GENERATED / "demand" / "reports" / "tokyo-kanagawa-demand.json", report)
    print(json.dumps({"tiles": report_tiles, "aggregation": aggregation, "crossPrefectureWorkers": sum(cross_mass.values()), "excludedRemoteIslandCells": excluded}, ensure_ascii=False))


if __name__ == "__main__":
    main()
