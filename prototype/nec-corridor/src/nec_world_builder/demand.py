from __future__ import annotations

import csv
import gzip
import hashlib
import json
import math
import os
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    import resource
except ImportError:  # Windows; psutil is used when available.
    resource = None  # type: ignore[assignment]

from pyproj import Transformer

from .inventory import CrosswalkIndex
from .selection import Selection
from .voronoi import cluster_demand_sites, pack_voronoi_cohorts


NEC_STATE_FILES = (
    ("09", "ct"), ("11", "dc"), ("10", "de"), ("25", "ma"), ("24", "md"), ("23", "me"), ("33", "nh"),
    ("34", "nj"), ("36", "ny"), ("42", "pa"), ("44", "ri"), ("51", "va"), ("50", "vt"), ("54", "wv"),
)


def default_nec_source_files(raw_dir: str | Path) -> tuple[list[tuple[str, Path]], list[tuple[str, Path]], list[tuple[str, Path]]]:
    raw = Path(raw_dir)
    crosswalk = [(fips, raw / f"{state}_xwalk.csv.gz") for fips, state in NEC_STATE_FILES]
    main = [(fips, raw / f"{state}_od_main_JT01_2023.csv.gz") for fips, state in NEC_STATE_FILES]
    aux = [(fips, raw / f"{state}_od_aux_JT01_2023.csv.gz") for fips, state in NEC_STATE_FILES]
    return crosswalk, main, aux


def _stable_id(*parts: object) -> str:
    payload = "\x1f".join(map(str, parts)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:24]


def _gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
            output.write(payload)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _peak_rss_bytes() -> int | None:
    try:
        import psutil  # type: ignore[import-not-found]

        return int(psutil.Process(os.getpid()).memory_info().rss)
    except ImportError:
        if resource is None:
            return None
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024)


def _departure_times(pop_id: str) -> tuple[int, int]:
    digest = int(hashlib.blake2b(pop_id.encode("utf-8"), digest_size=8).hexdigest(), 16)
    return 7 * 3600 + digest % 7_201, 16 * 3600 + (digest >> 16) % 7_201


def _gateway_for_pair(home_tile: str, work_tile: str, catalog_by_id: dict[str, dict[str, Any]]) -> dict[str, Any]:
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
        "id": f"NECGW_{left_id}_{right_id}",
        "x": closest(left[0], left[2], right[0], right[2]),
        "y": closest(left[1], left[3], right[1], right[3]),
    }


def _load_blocks(selection: Selection, crosswalk_files: Iterable[tuple[str, str | Path]]) -> tuple[dict[str, tuple[float, float, str | None]], dict[str, int]]:
    crosswalk = CrosswalkIndex(selection)
    rows_by_state: dict[str, int] = {}
    for state_fips, path in crosswalk_files:
        rows_by_state[str(state_fips).zfill(2)] = crosswalk.load(path, state_fips)
    return dict(crosswalk._records), rows_by_state  # The compiler owns this immutable in-memory lookup after loading.


def _insert_batches(database: sqlite3.Connection, batch: list[tuple[Any, ...]], table: str, columns: str, conflict: str) -> None:
    if not batch:
        return
    placeholders = ",".join("?" for _ in columns.split(","))
    database.executemany(
        f"INSERT INTO {table}({columns}) VALUES({placeholders}) ON CONFLICT {conflict} DO UPDATE SET mass=mass+excluded.mass",
        batch,
    )
    batch.clear()


def build_nec_demand(
    selection: Selection,
    catalog_path: str | Path,
    inventory_path: str | Path,
    crosswalk_files: Iterable[tuple[str, str | Path]],
    main_files: Iterable[tuple[str, str | Path]],
    aux_files: Iterable[tuple[str, str | Path]],
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

    inventory = json.loads(Path(inventory_path).read_text(encoding="utf-8"))
    if inventory.get("scope") != "selected-tile-pairs":
        raise ValueError("NEC demand packages require the map-only inventory")
    catalog_data = json.loads(Path(catalog_path).read_text(encoding="utf-8"))
    catalog_by_id = {str(tile["id"]): tile for tile in catalog_data["tiles"]}
    tiles = selected_tile_ids or list(selection.tile_ids)
    if set(tiles) != set(selection.tile_ids):
        raise ValueError("M4 currently requires all selected NEC tiles")
    if any(tile_id not in catalog_by_id for tile_id in tiles):
        raise ValueError("demand tile is absent from the generated catalog")

    blocks, crosswalk_rows = _load_blocks(selection, crosswalk_files)
    database = sqlite3.connect(database_path)
    counters: Counter[str] = Counter()
    site_weights: Counter[tuple[str, str]] = Counter()
    try:
        database.executescript(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;"
            "CREATE TABLE flows(tile TEXT NOT NULL,home_block TEXT NOT NULL,work_block TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(tile,home_block,work_block));"
            "CREATE TABLE cross_flows(home_tile TEXT NOT NULL,work_tile TEXT NOT NULL,home_block TEXT NOT NULL,work_block TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(home_tile,work_tile,home_block,work_block));"
        )
        local_batch: list[tuple[str, str, str, int]] = []
        cross_batch: list[tuple[str, str, str, str, int]] = []

        def flush() -> None:
            _insert_batches(database, local_batch, "flows", "tile,home_block,work_block,mass", "(tile,home_block,work_block)")
            _insert_batches(database, cross_batch, "cross_flows", "home_tile,work_tile,home_block,work_block,mass", "(home_tile,work_tile,home_block,work_block)")
            database.commit()

        def process(path: str | Path, source_kind: str) -> None:
            with gzip.open(Path(path), "rt", encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    mass = int(row["S000"])
                    counters["scannedRows"] += 1
                    counters["scannedWorkers"] += mass
                    home_id = str(row["h_geocode"]).zfill(15)
                    work_id = str(row["w_geocode"]).zfill(15)
                    home = blocks.get(home_id)
                    work = blocks.get(work_id)
                    if home is None or work is None or home[2] not in tiles or work[2] not in tiles:
                        counters["excludedRows"] += 1
                        counters["excludedWorkers"] += mass
                        continue
                    home_tile, work_tile = str(home[2]), str(work[2])
                    counters["retainedRows"] += 1
                    counters["retainedWorkers"] += mass
                    counters[f"{source_kind}Rows"] += 1
                    counters[f"{source_kind}Workers"] += mass
                    site_weights[(home_tile, home_id)] += mass
                    site_weights[(work_tile, work_id)] += mass
                    if home_tile == work_tile:
                        local_batch.append((home_tile, home_id, work_id, mass))
                        counters["localRows"] += 1
                        counters["localWorkers"] += mass
                    else:
                        cross_batch.append((home_tile, work_tile, home_id, work_id, mass))
                        counters["crossRows"] += 1
                        counters["crossWorkers"] += mass
                    if len(local_batch) + len(cross_batch) >= 25_000:
                        flush()

        for _, path in main_files:
            process(path, "main")
        for _, path in aux_files:
            process(path, "aux")
        flush()

        expected = inventory["totals"]
        if counters["retainedRows"] != int(expected["inputRows"]) or counters["retainedWorkers"] != int(expected["inputWorkers"]):
            raise AssertionError(
                "demand input does not match validated map inventory: "
                f"got {counters['retainedRows']}/{counters['retainedWorkers']}, "
                f"expected {expected['inputRows']}/{expected['inputWorkers']}"
            )

        weights_by_tile: dict[str, list[tuple[str, float, float, int]]] = defaultdict(list)
        for (tile_id, block_id), weight in site_weights.items():
            x, y, assigned_tile = blocks[block_id]
            if assigned_tile != tile_id:
                raise AssertionError(f"block {block_id} changed tile ownership")
            weights_by_tile[tile_id].append((block_id, x, y, weight))
        assignments: dict[tuple[str, str], str] = {}
        sites_by_tile: dict[str, dict[str, dict[str, Any]]] = {}
        for tile_id in tiles:
            assignment, sites = cluster_demand_sites(tile_id, weights_by_tile[tile_id], 100.0)
            assignments.update({(tile_id, block_id): site_id for block_id, site_id in assignment.items()})
            sites_by_tile[tile_id] = sites

        database.executescript(
            "CREATE TABLE site_flows(tile TEXT NOT NULL,home_site TEXT NOT NULL,work_site TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(tile,home_site,work_site));"
            "CREATE TABLE cross_site_flows(home_tile TEXT NOT NULL,work_tile TEXT NOT NULL,home_site TEXT NOT NULL,work_site TEXT NOT NULL,mass INTEGER NOT NULL,PRIMARY KEY(home_tile,work_tile,home_site,work_site));"
        )
        local_site_batch: list[tuple[str, str, str, int]] = []
        for tile_id, home_block, work_block, mass in database.execute("SELECT tile,home_block,work_block,mass FROM flows"):
            local_site_batch.append((tile_id, assignments[(tile_id, home_block)], assignments[(tile_id, work_block)], int(mass)))
            if len(local_site_batch) >= 25_000:
                _insert_batches(database, local_site_batch, "site_flows", "tile,home_site,work_site,mass", "(tile,home_site,work_site)")
                database.commit()
        _insert_batches(database, local_site_batch, "site_flows", "tile,home_site,work_site,mass", "(tile,home_site,work_site)")
        cross_site_batch: list[tuple[str, str, str, str, int]] = []
        for home_tile, work_tile, home_block, work_block, mass in database.execute("SELECT home_tile,work_tile,home_block,work_block,mass FROM cross_flows"):
            cross_site_batch.append((home_tile, work_tile, assignments[(home_tile, home_block)], assignments[(work_tile, work_block)], int(mass)))
            if len(cross_site_batch) >= 25_000:
                _insert_batches(database, cross_site_batch, "cross_site_flows", "home_tile,work_tile,home_site,work_site,mass", "(home_tile,work_tile,home_site,work_site)")
                database.commit()
        _insert_batches(database, cross_site_batch, "cross_site_flows", "home_tile,work_tile,home_site,work_site,mass", "(home_tile,work_tile,home_site,work_site)")
        database.commit()

        # The block-level tables are only staging inputs for site aggregation.
        # Drop them after both site tables are materialized so SQLite can reuse
        # their pages instead of holding two full OD representations at once.
        database.execute("DROP TABLE flows")
        database.execute("DROP TABLE cross_flows")
        database.commit()

        inverse = Transformer.from_crs(selection.grid.crs, "EPSG:4326", always_xy=True)
        all_sites = {site_id: site for tile_sites in sites_by_tile.values() for site_id, site in tile_sites.items()}
        minimum_size = 50
        maximum_size = 200
        target_size = 125
        cross_cohorts: list[dict[str, Any]] = []
        residuals: list[dict[str, Any]] = []
        for home_tile, work_tile, pair_mass in database.execute("SELECT home_tile,work_tile,SUM(mass) FROM cross_site_flows GROUP BY home_tile,work_tile ORDER BY home_tile,work_tile"):
            pair_mass = int(pair_mass)
            if pair_mass < minimum_size:
                rows = list(database.execute("SELECT home_site,work_site,mass FROM cross_site_flows WHERE home_tile=? AND work_tile=?", (home_tile, work_tile)))
                home_center = (sum(all_sites[h]["x"] * mass for h, _, mass in rows) / pair_mass, sum(all_sites[h]["y"] * mass for h, _, mass in rows) / pair_mass)
                work_center = (sum(all_sites[w]["x"] * mass for _, w, mass in rows) / pair_mass, sum(all_sites[w]["y"] * mass for _, w, mass in rows) / pair_mass)
                home_site = min(sites_by_tile[home_tile], key=lambda key: (math.dist(home_center, (sites_by_tile[home_tile][key]["x"], sites_by_tile[home_tile][key]["y"])), key))
                work_site = min(sites_by_tile[work_tile], key=lambda key: (math.dist(work_center, (sites_by_tile[work_tile][key]["x"], sites_by_tile[work_tile][key]["y"])), key))
                packed = [{"home": home_site, "work": work_site, "mass": pair_mass, "part": 0}]
                residuals.append({"homeTileId": home_tile, "workTileId": work_tile, "workers": pair_mass})
            else:
                packed = pack_voronoi_cohorts(
                    database,
                    f"{home_tile}->{work_tile}",
                    all_sites,
                    minimum_size,
                    maximum_size,
                    target_size,
                    flow_query="SELECT home_site,work_site,mass FROM cross_site_flows WHERE home_tile=? AND work_tile=?",
                    flow_parameters=(home_tile, work_tile),
                    home_site_ids=sites_by_tile[home_tile],
                    work_site_ids=sites_by_tile[work_tile],
                )
            gateway = _gateway_for_pair(home_tile, work_tile, catalog_by_id)
            for index, cohort in enumerate(packed):
                home = all_sites[cohort["home"]]
                work = all_sites[cohort["work"]]
                straight = max(1, round(math.dist((home["x"], home["y"]), (work["x"], work["y"]))))
                drive = max(1, round(straight * 1.3))
                cross_cohorts.append({
                    "id": f"nec-cross-pop-{_stable_id('nec-cross-v1', home_tile, work_tile, home['id'], work['id'], cohort['part'], index)}",
                    "mass": int(cohort["mass"]),
                    "home": home,
                    "work": work,
                    "homeTileId": home_tile,
                    "workTileId": work_tile,
                    "gatewayId": gateway["id"],
                    "straightDistance": straight,
                    "drivingDistance": drive,
                    "drivingSeconds": max(60, round(drive / (40 / 3.6))),
                })

        for cohort in cross_cohorts:
            if cohort["home"]["tileId"] != cohort["homeTileId"]:
                raise AssertionError(f"Cross-demand home site escaped its tile: {cohort['id']}")
            if cohort["work"]["tileId"] != cohort["workTileId"]:
                raise AssertionError(f"Cross-demand work site escaped its tile: {cohort['id']}")

        gateway_rows: dict[str, dict[str, Any]] = {}
        for cohort in cross_cohorts:
            gateway = _gateway_for_pair(cohort["homeTileId"], cohort["workTileId"], catalog_by_id)
            longitude, latitude = inverse.transform(gateway["x"], gateway["y"])
            gateway_rows.setdefault(gateway["id"], {"id": gateway["id"], "location": [round(longitude, 7), round(latitude, 7)], "capacityPerHour": 100_000})
        gateway_ids = sorted(gateway_rows)
        gateway_index = {gateway_id: index for index, gateway_id in enumerate(gateway_ids)}
        cross_points: dict[str, dict[str, Any]] = {}
        cross_pops: list[dict[str, Any]] = []
        commute_totals: dict[tuple[str, str, str], dict[str, int]] = {}
        for cohort in sorted(cross_cohorts, key=lambda row: row["id"]):
            for role, site in (("residents", cohort["home"]), ("workers", cohort["work"])):
                longitude, latitude = inverse.transform(site["x"], site["y"])
                point = cross_points.setdefault(site["id"], {"id": site["id"], "longitude": round(longitude, 7), "latitude": round(latitude, 7), "tileId": site["tileId"], "residents": 0, "workers": 0})
                point[role] += cohort["mass"]
            home_departure, work_departure = _departure_times(cohort["id"])
            cross_pops.append({**cohort, "homeDepartureTime": home_departure, "workDepartureTime": work_departure})
            key = (cohort["homeTileId"], cohort["workTileId"], cohort["gatewayId"])
            total = commute_totals.setdefault(key, {"mass": 0, "weightedSeconds": 0})
            total["mass"] += cohort["mass"]
            total["weightedSeconds"] += cohort["drivingSeconds"] * cohort["mass"]
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
            "pops": [[cohort["id"], cohort["mass"], cross_point_index[cohort["home"]["id"]], cross_point_index[cohort["work"]["id"]], gateway_index[cohort["gatewayId"]], cohort["homeDepartureTime"], cohort["workDepartureTime"], cohort["drivingSeconds"], cohort["drivingDistance"]] for cohort in cross_pops],
        }
        commute_buckets = [{"id": f"nec-cross-flow-{_stable_id('nec-cross-v1', *key)}", "homeTileId": key[0], "workTileId": key[1], "gatewayId": key[2], "mass": value["mass"], "defaultTravelSeconds": max(60, round(value["weightedSeconds"] / value["mass"])), "defaultCapacityPerHour": 100_000} for key, value in sorted(commute_totals.items())]
        commute_parts = [f"{row['id']}:{row['mass']}" for row in commute_buckets]
        commute_catalog = {"schemaVersion": 1, "buildHash": f"nec-cross-v1-{_stable_id(*commute_parts)}", "buckets": commute_buckets, "gateways": [gateway_rows[key] for key in gateway_ids]}

        global_dir = output / "world"
        _gzip_json(global_dir / "cross_demand.json.gz", cross_demand)
        _write_json(global_dir / "cross_commutes.json", commute_catalog)
        tile_reports: list[dict[str, Any]] = []
        for tile_id in tiles:
            tile_started = time.perf_counter()
            cohorts = pack_voronoi_cohorts(database, tile_id, sites_by_tile[tile_id], minimum_size, maximum_size, target_size)
            point_map: dict[str, dict[str, Any]] = {}
            pops: list[dict[str, Any]] = []
            for index, cohort in enumerate(cohorts):
                home, work = sites_by_tile[tile_id][cohort["home"]], sites_by_tile[tile_id][cohort["work"]]
                pop_id = f"nec-native-pop-{_stable_id('nec-native-v1', tile_id, home['id'], work['id'], cohort['part'], index)}"
                distance = max(1, round(math.dist((home["x"], home["y"]), (work["x"], work["y"]))))
                pops.append({"id": pop_id, "size": cohort["mass"], "residenceId": home["id"], "jobId": work["id"], "drivingSeconds": max(60, round(distance / 13.4)), "drivingDistance": distance})
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
            _write_json(cross_commutes_path, {**commute_catalog, "tileId": tile_id})
            cross_demand_path = tile_dir / "cross_demand.json.gz"
            _gzip_json(cross_demand_path, {**cross_demand, "tileId": tile_id})
            manifest = {
                "schemaVersion": 1,
                "tileId": tile_id,
                "cityCode": tile_id,
                "dataFiles": {"demandData": "demand_data.json.gz"},
                "assets": [{"path": name, "bytes": path.stat().st_size, "sha256": _sha256(path)} for name, path in (("demand_data.json.gz", demand_path), ("cross_commutes.json", cross_commutes_path), ("cross_demand.json.gz", cross_demand_path))],
                "runtimeFiles": {"schemaVersion": 1, "crossCommutes": {"path": "cross_commutes.json", "encoding": "canonical-json", "role": "cross-tile-commute-summary"}, "crossDemand": {"path": "cross_demand.json.gz", "encoding": "gzip-json", "role": "cross-tile-demand-viewer"}},
            }
            _write_json(tile_dir / "manifest.json", manifest)
            masses = [int(row["size"]) for row in pops]
            tile_reports.append({"tileId": tile_id, "localWorkers": sum(masses), "siteCount": len(point_map), "cohortCount": len(pops), "minimumCohort": min(masses, default=0), "maximumCohort": max(masses, default=0), "demandBytes": demand_path.stat().st_size, "elapsedSeconds": round(time.perf_counter() - tile_started, 3)})
    finally:
        database.close()

    report = {
        "schemaVersion": 1,
        "worldId": "NEC_CORRIDOR_LODES_PROTOTYPE",
        "prototype": True,
        "source": {"lodesVersion": "LODES8", "vintage": 2023, "jobType": "JT01", "workerColumn": "S000"},
        "aggregation": {"pointMergeDistanceM": 100, "minimumCohortSize": 50, "maximumCohortSize": 200, "algorithm": "deterministic sparse Voronoi sites; weighted 4D capacity-constrained Voronoi cohorts", "drivingModel": "straight-line at 13.4 m/s; OSRM enrichment pending"},
        "crosswalkRowsByStateFips": crosswalk_rows,
        "inputRows": counters["retainedRows"],
        "inputWorkers": counters["retainedWorkers"],
        "scannedRows": counters["scannedRows"],
        "scannedWorkers": counters["scannedWorkers"],
        "excludedRows": counters["excludedRows"],
        "excludedWorkers": counters["excludedWorkers"],
        "localWorkers": counters["localWorkers"],
        "crossTileWorkers": counters["crossWorkers"],
        "crossTileCohorts": len(cross_cohorts),
        "directedTilePairs": len(commute_buckets),
        "undersizedCrossTileResiduals": residuals,
        "tiles": tile_reports,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "peakRssBytesAtFinish": _peak_rss_bytes(),
        "workDatabaseBytes": database_path.stat().st_size,
    }
    _write_json(output / "reports" / "nec-demand.json", report)
    return report
