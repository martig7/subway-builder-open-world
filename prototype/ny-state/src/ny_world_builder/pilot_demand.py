from __future__ import annotations

import csv
import gzip
import hashlib
import json
import math
import os
import sqlite3
import time
from collections import Counter
from pathlib import Path
from typing import Any

from pyproj import Transformer

from .config import WorldConfig
from .util import sha256_file, write_json
from .voronoi import cluster_demand_sites, pack_voronoi_cohorts

DEFAULT_CANARY_TILE_IDS = (
    "NY_CP00_RP00",  # New York City
    "NY_CP00_RP01",  # Lower Hudson
    "NY_CP01_RP00",  # Long Island
    "NY_CM01_RP01",  # Catskills
    "NY_CM01_RP02",  # Mohawk Valley
    "NY_CM01_RP03",  # Adirondacks
    "NY_CP00_RP02",  # Albany / Capital Region
)


def _stable_id(*parts: object) -> str:
    payload = "\x1f".join(map(str, parts)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:24]


def _gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
            output.write(payload)


def _peak_rss_bytes() -> int | None:
    try:
        import psutil  # type: ignore[import-not-found]

        return int(psutil.Process(os.getpid()).memory_info().rss)
    except ImportError:
        return None


def _load_pilots(inventory_path: Path) -> list[str]:
    # Read the inventory so a missing/stale Milestone-0 prerequisite still
    # fails early, but use the explicitly frozen canary corridor selection.
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    inventoried = {str(row["tileId"]) for row in inventory["tiles"]}
    missing = sorted(set(DEFAULT_CANARY_TILE_IDS) - inventoried)
    if missing:
        raise ValueError(f"canary tiles are absent from the LODES inventory: {missing}")
    return list(DEFAULT_CANARY_TILE_IDS)


def _gateway_for_pair(
    home_tile: str,
    work_tile: str,
    catalog_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    left_id, right_id = sorted((home_tile, work_tile))
    left = catalog_by_id[left_id]["ownershipProjected"]
    right = catalog_by_id[right_id]["ownershipProjected"]

    def closest(left_min: float, left_max: float, right_min: float, right_max: float) -> float:
        if left_max < right_min:
            return (left_max + right_min) / 2
        if right_max < left_min:
            return (right_max + left_min) / 2
        return (max(left_min, right_min) + min(left_max, right_max)) / 2

    return {
        "id": f"NYGW_{left_id}_{right_id}",
        "x": closest(left[0], left[2], right[0], right[2]),
        "y": closest(left[1], left[3], right[1], right[3]),
    }


def _departure_times(pop_id: str) -> tuple[int, int]:
    digest = int(hashlib.blake2b(pop_id.encode("utf-8"), digest_size=8).hexdigest(), 16)
    return 7 * 3600 + digest % 7_201, 16 * 3600 + (digest >> 16) % 7_201


def _load_blocks(
    config: WorldConfig,
    catalog_path: Path,
    crosswalk_path: Path,
) -> dict[str, tuple[float, float, str | None]]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    addressable = {(int(tile["column"]), int(tile["row"])): str(tile["id"]) for tile in catalog["tiles"]}
    transformer = Transformer.from_crs("EPSG:4326", config.crs, always_xy=True)
    result: dict[str, tuple[float, float, str | None]] = {}
    with gzip.open(crosswalk_path, "rt", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            x, y = transformer.transform(float(row["blklondd"]), float(row["blklatdd"]))
            coordinate = config.grid.coordinates(x, y)
            result[str(row["tabblk2020"])] = (x, y, addressable.get(coordinate))
    return result


def _cluster_sites(
    tile_id: str,
    locations: list[tuple[str, float, float, int]],
    radius: float,
) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    return cluster_demand_sites(tile_id, locations, radius)


def _pack_tile(
    database: sqlite3.Connection,
    tile_id: str,
    sites: dict[str, dict[str, Any]],
    minimum_size: int,
    maximum_size: int,
) -> list[dict[str, Any]]:
    return pack_voronoi_cohorts(
        database,
        tile_id,
        sites,
        minimum_size,
        maximum_size,
        (minimum_size + maximum_size) // 2,
        progress=lambda message: print(f"[ny-demand] {message}", flush=True),
    )


def compile_pilot_demand(
    config: WorldConfig,
    catalog_path: str | Path,
    inventory_path: str | Path,
    crosswalk_path: str | Path,
    main_path: str | Path,
    output_dir: str | Path,
    work_database: str | Path,
    selected_tile_ids: list[str] | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    output = Path(output_dir)
    database_path = Path(work_database)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    if database_path.exists():
        database_path.unlink()
    configured_pilots = _load_pilots(Path(inventory_path))
    pilots = selected_tile_ids or configured_pilots
    catalog_data = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    catalog_by_id = {str(tile["id"]): tile for tile in catalog_data["tiles"] if tile["status"] == "normal"}
    unknown_tiles = sorted(set(pilots) - set(catalog_by_id))
    if unknown_tiles:
        raise ValueError(f"selected tiles are not normal addressable tiles: {unknown_tiles}")
    if not pilots or len(set(pilots)) != len(pilots):
        raise ValueError(f"selected tiles must be unique and nonempty: {pilots}")
    pilot_set = set(pilots)
    blocks = _load_blocks(config, Path(catalog_path), Path(crosswalk_path))
    weights: Counter[tuple[str, str]] = Counter()
    tile_pairs: Counter[tuple[str, str]] = Counter()
    counters: Counter[str] = Counter()

    database = sqlite3.connect(database_path)
    try:
        database.executescript(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;"
            "CREATE TABLE flows(tile TEXT NOT NULL,home_block TEXT NOT NULL,work_block TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(tile,home_block,work_block));"
            "CREATE TABLE cross_flows(home_tile TEXT NOT NULL,work_tile TEXT NOT NULL,home_block TEXT NOT NULL,work_block TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(home_tile,work_tile,home_block,work_block));"
        )
        batch: list[tuple[str, str, str, int]] = []
        cross_batch: list[tuple[str, str, str, str, int]] = []

        def flush_batches() -> None:
            if batch:
                database.executemany(
                    "INSERT INTO flows VALUES(?,?,?,?) ON CONFLICT(tile,home_block,work_block) DO UPDATE SET mass=mass+excluded.mass",
                    batch,
                )
                batch.clear()
            if cross_batch:
                database.executemany(
                    "INSERT INTO cross_flows VALUES(?,?,?,?,?) ON CONFLICT(home_tile,work_tile,home_block,work_block) DO UPDATE SET mass=mass+excluded.mass",
                    cross_batch,
                )
                cross_batch.clear()
            database.commit()

        with gzip.open(main_path, "rt", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                mass = int(row["S000"])
                home = blocks.get(row["h_geocode"])
                work = blocks.get(row["w_geocode"])
                counters["inputRows"] += 1
                counters["inputWorkers"] += mass
                if home is None or work is None or home[2] is None or work[2] is None:
                    counters["unresolvedWorkers"] += mass
                    continue
                home_tile, work_tile = home[2], work[2]
                tile_pairs[(home_tile, work_tile)] += mass
                if home_tile in pilot_set and work_tile in pilot_set:
                    weights[(home_tile, row["h_geocode"])] += mass
                    weights[(work_tile, row["w_geocode"])] += mass
                if home_tile == work_tile and home_tile in pilot_set:
                    batch.append((home_tile, row["h_geocode"], row["w_geocode"], mass))
                    counters[f"{home_tile}.localRows"] += 1
                    counters[f"{home_tile}.localWorkers"] += mass
                elif home_tile in pilot_set and work_tile in pilot_set:
                    cross_batch.append((home_tile, work_tile, row["h_geocode"], row["w_geocode"], mass))
                    counters["pilotCrossWorkers"] += mass
                    counters[f"{home_tile}|{work_tile}.crossWorkers"] += mass
                elif home_tile in pilot_set or work_tile in pilot_set:
                    counters["externalCrossWorkers"] += mass
                if len(batch) + len(cross_batch) >= 25_000:
                    flush_batches()
        flush_batches()

        assignments: dict[tuple[str, str], str] = {}
        sites_by_tile: dict[str, dict[str, dict[str, Any]]] = {}
        for tile_id in pilots:
            locations = [
                (block_id, blocks[block_id][0], blocks[block_id][1], weight)
                for (owner, block_id), weight in weights.items()
                if owner == tile_id
            ]
            tile_assignment, sites = _cluster_sites(tile_id, locations, float(config.cohort["pointMergeDistanceM"])) if locations else ({}, {})
            assignments.update({(tile_id, block_id): site_id for block_id, site_id in tile_assignment.items()})
            sites_by_tile[tile_id] = sites

        database.executescript(
            "CREATE TABLE site_flows(tile TEXT NOT NULL,home_site TEXT NOT NULL,work_site TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(tile,home_site,work_site));"
            "CREATE TABLE cross_site_flows(home_tile TEXT NOT NULL,work_tile TEXT NOT NULL,home_site TEXT NOT NULL,work_site TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(home_tile,work_tile,home_site,work_site));"
        )
        batch = []
        for tile_id, home_block, work_block, mass in database.execute("SELECT tile,home_block,work_block,mass FROM flows"):
            home_site = assignments[(tile_id, home_block)]
            work_site = assignments[(tile_id, work_block)]
            batch.append((tile_id, home_site, work_site, int(mass)))
            if len(batch) >= 25_000:
                database.executemany(
                    "INSERT INTO site_flows VALUES(?,?,?,?) ON CONFLICT(tile,home_site,work_site) DO UPDATE SET mass=mass+excluded.mass",
                    batch,
                )
                database.commit()
                batch.clear()
        if batch:
            database.executemany(
                "INSERT INTO site_flows VALUES(?,?,?,?) ON CONFLICT(tile,home_site,work_site) DO UPDATE SET mass=mass+excluded.mass",
                batch,
            )
            database.commit()
        cross_site_batch: list[tuple[str, str, str, str, int]] = []
        for home_tile, work_tile, home_block, work_block, mass in database.execute(
            "SELECT home_tile,work_tile,home_block,work_block,mass FROM cross_flows"
        ):
            cross_site_batch.append((
                home_tile,
                work_tile,
                assignments[(home_tile, home_block)],
                assignments[(work_tile, work_block)],
                int(mass),
            ))
            if len(cross_site_batch) >= 25_000:
                database.executemany(
                    "INSERT INTO cross_site_flows VALUES(?,?,?,?,?) ON CONFLICT(home_tile,work_tile,home_site,work_site) DO UPDATE SET mass=mass+excluded.mass",
                    cross_site_batch,
                )
                database.commit()
                cross_site_batch.clear()
        if cross_site_batch:
            database.executemany(
                "INSERT INTO cross_site_flows VALUES(?,?,?,?,?) ON CONFLICT(home_tile,work_tile,home_site,work_site) DO UPDATE SET mass=mass+excluded.mass",
                cross_site_batch,
            )
            database.commit()
        database.commit()

        inverse = Transformer.from_crs(config.crs, "EPSG:4326", always_xy=True)
        all_sites = {site_id: site for tile_sites in sites_by_tile.values() for site_id, site in tile_sites.items()}
        cross_cohorts: list[dict[str, Any]] = []
        cross_residuals: list[dict[str, Any]] = []
        cross_pairs = list(database.execute(
            "SELECT home_tile,work_tile,SUM(mass) FROM cross_site_flows GROUP BY home_tile,work_tile ORDER BY home_tile,work_tile"
        ))
        minimum_size = int(config.cohort["nativeMinimumSize"])
        maximum_size = int(config.cohort["maximumSize"])
        for home_tile, work_tile, pair_mass in cross_pairs:
            pair_mass = int(pair_mass)
            if pair_mass < minimum_size:
                rows = list(database.execute(
                    "SELECT home_site,work_site,mass FROM cross_site_flows WHERE home_tile=? AND work_tile=?",
                    (home_tile, work_tile),
                ))
                home_center = (
                    sum(all_sites[home]["x"] * mass for home, _, mass in rows) / pair_mass,
                    sum(all_sites[home]["y"] * mass for home, _, mass in rows) / pair_mass,
                )
                work_center = (
                    sum(all_sites[work]["x"] * mass for _, work, mass in rows) / pair_mass,
                    sum(all_sites[work]["y"] * mass for _, work, mass in rows) / pair_mass,
                )
                home_candidates = sites_by_tile[home_tile]
                work_candidates = sites_by_tile[work_tile]
                packed = [{
                    "home": min(home_candidates, key=lambda key: (math.dist(home_center, (home_candidates[key]["x"], home_candidates[key]["y"])), key)),
                    "work": min(work_candidates, key=lambda key: (math.dist(work_center, (work_candidates[key]["x"], work_candidates[key]["y"])), key)),
                    "mass": pair_mass,
                    "part": 0,
                }]
                cross_residuals.append({"homeTileId": home_tile, "workTileId": work_tile, "workers": pair_mass})
            else:
                packed = pack_voronoi_cohorts(
                    database,
                    f"{home_tile}->{work_tile}",
                    all_sites,
                    minimum_size,
                    maximum_size,
                    (minimum_size + maximum_size) // 2,
                    progress=lambda message: print(f"[ny-cross-demand] {message}", flush=True),
                    flow_query="SELECT home_site,work_site,mass FROM cross_site_flows WHERE home_tile=? AND work_tile=?",
                    flow_parameters=(home_tile, work_tile),
                )
            gateway = _gateway_for_pair(home_tile, work_tile, catalog_by_id)
            for index, cohort in enumerate(packed):
                home = all_sites[cohort["home"]]
                work = all_sites[cohort["work"]]
                straight_distance = max(1, round(math.dist((home["x"], home["y"]), (work["x"], work["y"]))))
                driving_distance = max(1, round(straight_distance * 1.3))
                cross_cohorts.append({
                    "id": f"cross-pop-{_stable_id('ny-cross-v2', home_tile, work_tile, home['id'], work['id'], cohort['part'], index)}",
                    "mass": int(cohort["mass"]),
                    "home": home,
                    "work": work,
                    "homeTileId": home_tile,
                    "workTileId": work_tile,
                    "gatewayId": gateway["id"],
                    "straightDistance": straight_distance,
                    "drivingDistance": driving_distance,
                    "drivingSeconds": max(60, round(driving_distance / (40 / 3.6))),
                })

        gateway_rows: dict[str, dict[str, Any]] = {}
        for cohort in cross_cohorts:
            gateway = _gateway_for_pair(cohort["homeTileId"], cohort["workTileId"], catalog_by_id)
            longitude, latitude = inverse.transform(gateway["x"], gateway["y"])
            gateway_rows.setdefault(gateway["id"], {
                "id": gateway["id"],
                "location": [round(longitude, 7), round(latitude, 7)],
                "capacityPerHour": 100_000,
            })
        gateway_ids = sorted(gateway_rows)
        gateway_index = {gateway_id: index for index, gateway_id in enumerate(gateway_ids)}
        cross_points: dict[str, dict[str, Any]] = {}
        cross_pop_rows = []
        commute_totals: dict[tuple[str, str, str], dict[str, int]] = {}
        farthest: dict[str, Any] | None = None
        for cohort in sorted(cross_cohorts, key=lambda row: row["id"]):
            for role, site in (("residents", cohort["home"]), ("workers", cohort["work"])):
                longitude, latitude = inverse.transform(site["x"], site["y"])
                point = cross_points.setdefault(site["id"], {
                    "id": site["id"], "longitude": round(longitude, 7), "latitude": round(latitude, 7),
                    "tileId": site["tileId"], "residents": 0, "workers": 0,
                })
                point[role] += cohort["mass"]
            home_departure, work_departure = _departure_times(cohort["id"])
            cross_pop_rows.append({**cohort, "homeDepartureTime": home_departure, "workDepartureTime": work_departure})
            key = (cohort["homeTileId"], cohort["workTileId"], cohort["gatewayId"])
            total = commute_totals.setdefault(key, {"mass": 0, "weightedSeconds": 0})
            total["mass"] += cohort["mass"]
            total["weightedSeconds"] += cohort["drivingSeconds"] * cohort["mass"]
            if farthest is None or (cohort["straightDistance"], cohort["id"]) > (farthest["straightDistance"], farthest["id"]):
                farthest = cohort

        cross_point_ids = sorted(cross_points)
        cross_point_index = {point_id: index for index, point_id in enumerate(cross_point_ids)}
        cross_demand = {
            "schemaVersion": 1,
            "tileId": None,
            "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
            "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance"],
            "drivingModel": {"provider": "geometric", "label": "straight-line ×1.3 at 40 km/h"},
            "gateways": gateway_ids,
            "points": [[point["id"], point["longitude"], point["latitude"], point["tileId"], point["residents"], point["workers"]] for point in (cross_points[key] for key in cross_point_ids)],
            "pops": [[
                cohort["id"], cohort["mass"], cross_point_index[cohort["home"]["id"]], cross_point_index[cohort["work"]["id"]], gateway_index[cohort["gatewayId"]],
                cohort["homeDepartureTime"], cohort["workDepartureTime"], cohort["drivingSeconds"], cohort["drivingDistance"],
            ] for cohort in cross_pop_rows],
        }
        commute_buckets = [{
            "id": f"cross-flow-{_stable_id('ny-cross-v2', *key)}",
            "homeTileId": key[0], "workTileId": key[1], "gatewayId": key[2], "mass": value["mass"],
            "defaultTravelSeconds": max(60, round(value["weightedSeconds"] / value["mass"])),
            "defaultCapacityPerHour": 100_000,
        } for key, value in sorted(commute_totals.items())]
        commute_build_parts = [f"{row['id']}:{row['mass']}" for row in commute_buckets]
        commute_catalog = {
            "schemaVersion": 1,
            "buildHash": f"ny-cross-v2-{_stable_id(*commute_build_parts)}",
            "buckets": commute_buckets,
            "gateways": [gateway_rows[key] for key in gateway_ids],
        }
        farthest_summary = None
        if farthest is not None:
            home_longitude, home_latitude = inverse.transform(farthest["home"]["x"], farthest["home"]["y"])
            work_longitude, work_latitude = inverse.transform(farthest["work"]["x"], farthest["work"]["y"])
            farthest_summary = {
                "popId": farthest["id"],
                "workers": farthest["mass"],
                "homeTileId": farthest["homeTileId"],
                "workTileId": farthest["workTileId"],
                "homePointId": farthest["home"]["id"],
                "workPointId": farthest["work"]["id"],
                "homeLocation": [round(home_longitude, 7), round(home_latitude, 7)],
                "workLocation": [round(work_longitude, 7), round(work_latitude, 7)],
                "straightDistanceM": farthest["straightDistance"],
                "drivingDistanceM": farthest["drivingDistance"],
                "drivingSeconds": farthest["drivingSeconds"],
            }

        tile_reports: list[dict[str, Any]] = []
        for tile_id in pilots:
            tile_started = time.perf_counter()
            sites = sites_by_tile[tile_id]
            cohorts = _pack_tile(
                database,
                tile_id,
                sites,
                int(config.cohort["nativeMinimumSize"]),
                int(config.cohort["maximumSize"]),
            )
            point_map: dict[str, dict[str, Any]] = {}
            pops = []
            for index, cohort in enumerate(cohorts):
                home, work = sites[cohort["home"]], sites[cohort["work"]]
                pop_id = f"native-pop-{_stable_id('ny-pilot-v1', tile_id, home['id'], work['id'], cohort['part'], index)}"
                distance = max(1, round(math.dist((home["x"], home["y"]), (work["x"], work["y"]))))
                pops.append({
                    "id": pop_id,
                    "size": cohort["mass"],
                    "residenceId": home["id"],
                    "jobId": work["id"],
                    "drivingSeconds": max(60, round(distance / 13.4)),
                    "drivingDistance": distance,
                })
                for site in (home, work):
                    longitude, latitude = inverse.transform(site["x"], site["y"])
                    point_map.setdefault(site["id"], {"id": site["id"], "location": [round(longitude, 7), round(latitude, 7)], "jobs": 0, "residents": 0, "popIds": []})
                point_map[home["id"]]["residents"] += cohort["mass"]
                point_map[home["id"]]["popIds"].append(pop_id)
                point_map[work["id"]]["jobs"] += cohort["mass"]
                if work["id"] != home["id"]:
                    point_map[work["id"]]["popIds"].append(pop_id)
            tile_dir = output / "tiles" / tile_id
            demand_path = tile_dir / "demand_data.json.gz"
            _gzip_json(demand_path, {"points": [point_map[key] for key in sorted(point_map)], "pops": sorted(pops, key=lambda row: row["id"])})
            cross_commutes_path = tile_dir / "cross_commutes.json"
            write_json(cross_commutes_path, {**commute_catalog, "tileId": tile_id})
            cross_demand_path = tile_dir / "cross_demand.json.gz"
            _gzip_json(cross_demand_path, {**cross_demand, "tileId": tile_id})
            manifest = {
                "schemaVersion": 1,
                "tileId": tile_id,
                "cityCode": tile_id,
                "dataFiles": {"demandData": "demand_data.json.gz"},
                "assets": [
                    {"path": "demand_data.json.gz", "bytes": demand_path.stat().st_size, "sha256": sha256_file(demand_path)},
                    {"path": "cross_commutes.json", "bytes": cross_commutes_path.stat().st_size, "sha256": sha256_file(cross_commutes_path)},
                    {"path": "cross_demand.json.gz", "bytes": cross_demand_path.stat().st_size, "sha256": sha256_file(cross_demand_path)},
                ],
                "runtimeFiles": {
                    "schemaVersion": 1,
                    "crossCommutes": {"path": "cross_commutes.json", "encoding": "canonical-json", "role": "cross-tile-commute-summary"},
                    "crossDemand": {"path": "cross_demand.json.gz", "encoding": "gzip-json", "role": "cross-tile-demand-viewer"},
                },
            }
            write_json(tile_dir / "manifest.json", manifest)
            masses = [int(row["size"]) for row in pops]
            tile_reports.append({
                "tileId": tile_id,
                "localOdRows": counters[f"{tile_id}.localRows"],
                "localWorkers": counters[f"{tile_id}.localWorkers"],
                "siteCount": len(point_map),
                "cohortCount": len(pops),
                "minimumCohort": min(masses, default=0),
                "maximumCohort": max(masses, default=0),
                "demandBytes": demand_path.stat().st_size,
                "elapsedSeconds": round(time.perf_counter() - tile_started, 3),
            })
    finally:
        database.close()

    report = {
        "schemaVersion": 1,
        "prototype": True,
        "pilotTiles": pilots,
        "source": {"lodesVintage": config.demand["vintage"], "jobType": config.demand["jobType"]},
        "aggregation": {
            "pointMergeDistanceM": config.cohort["pointMergeDistanceM"],
            "minimumCohortSize": config.cohort["nativeMinimumSize"],
            "maximumCohortSize": config.cohort["maximumSize"],
            "algorithm": "deterministic sparse Voronoi sites; weighted 4D capacity-constrained Voronoi cohorts",
            "drivingModel": "straight-line at 13.4 m/s; OSRM enrichment pending",
        },
        "inputRows": counters["inputRows"],
        "inputWorkers": counters["inputWorkers"],
        "pilotCrossWorkers": counters["pilotCrossWorkers"],
        "crossTile": {
            "workers": sum(row["mass"] for row in cross_cohorts),
            "cohortCount": len(cross_cohorts),
            "pointCount": len(cross_points),
            "directedTilePairs": len(cross_pairs),
            "undersizedResiduals": cross_residuals,
            "farthestCommute": farthest_summary,
        },
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "peakRssBytesAtFinish": _peak_rss_bytes(),
        "workDatabaseBytes": database_path.stat().st_size,
        "tiles": tile_reports,
    }
    write_json(output / "reports" / "pilot-demand.json", report)
    lines = [
        f"# {len(pilots)}-tile pilot demand benchmark",
        "",
        "PROTOTYPE — real 2023 NY LODES8 JT01 data; deterministic 100 m sites and 50–200 person cohorts.",
        "",
        f"- Input: **{report['inputRows']:,}** rows / **{report['inputWorkers']:,}** workers",
        f"- Build time: **{report['elapsedSeconds']:.1f} s**",
        f"- SQLite work file: **{report['workDatabaseBytes'] / 2**20:.1f} MiB**",
        f"- Cross-tile demand: **{report['crossTile']['workers']:,} workers / {report['crossTile']['cohortCount']:,} cohorts / {report['crossTile']['directedTilePairs']} directed tile pairs**",
        "- Driving times are geometric placeholders until the routing stage runs.",
        "",
        "| Tile | Local OD rows | Workers | Sites | Cohorts | Cohort range | Gzip MiB |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in tile_reports:
        lines.append(
            f"| `{row['tileId']}` | {row['localOdRows']:,} | {row['localWorkers']:,} | {row['siteCount']:,} | "
            f"{row['cohortCount']:,} | {row['minimumCohort']}–{row['maximumCohort']} | {row['demandBytes'] / 2**20:.2f} |"
        )
    (output / "reports" / "pilot-demand.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return report
