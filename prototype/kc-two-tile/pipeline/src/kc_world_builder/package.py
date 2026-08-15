from __future__ import annotations

import gzip
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable

from .compile_demand import Cohort, projections
from .config import WorldConfig
from .driving_routes import DrivingRouter
from .util import canonical_json, sha256_file, stable_id, write_json


DEFAULT_CROSS_COMMUTE_TRAVEL_SECONDS = 1_800
# A feasibility placeholder, not a claim about one physical station. At the
# current KC masses 1,000/hour leaves the largest bucket stranded past the
# evening return window; 10,000/hour clears each gateway in roughly two hours.
DEFAULT_CROSS_COMMUTE_CAPACITY_PER_HOUR = 10_000
LOCAL_FALLBACK_SPEED_MPS = 13.4
CROSS_FALLBACK_SPEED_MPS = 40 / 3.6
CROSS_FALLBACK_CIRCUITY = 1.3
MIN_COMMUTE_GAP_SECONDS = 90 * 60

# Subway Builder 1.6's default time-of-day ranges. Departure ranges are
# sampled in proportion to demand multiplier × duration, just like the native
# assignCommuteTimes/generateTimeSlots path, but use a stable hash in place of
# Math.random so generated packages remain reproducible.
TIME_OF_DAY_RANGES = (
    (0, 3, 0.15, 0.15),
    (3, 6, 0.30, 0.30),
    (6, 7, 1.00, 0.30),
    (7, 10, 2.50, 0.30),
    (10, 11, 1.00, 0.80),
    (11, 15, 0.80, 0.80),
    (15, 16, 0.80, 1.00),
    (16, 19, 0.30, 2.50),
    (19, 20, 0.30, 1.00),
    (20, 23, 0.30, 0.30),
    (23, 24, 0.15, 0.15),
)


def _stable_fraction(*parts: object) -> float:
    digest = hashlib.sha256("\x1f".join(map(str, parts)).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def _sample_departure(pop_id: str, direction: str, attempt: int = 0) -> float:
    demand_index = 2 if direction == "home" else 3
    weights = [(row[1] - row[0]) * row[demand_index] for row in TIME_OF_DAY_RANGES]
    target = _stable_fraction(pop_id, direction, attempt, "range") * sum(weights)
    selected = TIME_OF_DAY_RANGES[-1]
    cumulative = 0.0
    for row, weight in zip(TIME_OF_DAY_RANGES, weights, strict=True):
        cumulative += weight
        if target <= cumulative:
            selected = row
            break
    start, end = selected[:2]
    return start * 3_600 + _stable_fraction(pop_id, direction, attempt, "within") * (end - start) * 3_600


def _commute_departures(pop_id: str) -> tuple[float, float]:
    home = _sample_departure(pop_id, "home")
    for attempt in range(100):
        work = _sample_departure(pop_id, "work", attempt)
        if abs(work - home) >= MIN_COMMUTE_GAP_SECONDS:
            return home, work
    raise ValueError(f"could not assign separated commute times: {pop_id}")


def _utm15_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """Inverse NAD83 / UTM zone 15N for this fixed-CRS prototype."""
    semi_major = 6_378_137.0
    inverse_flattening = 298.257222101
    eccentricity_sq = (1 / inverse_flattening) * (2 - 1 / inverse_flattening)
    eccentricity_prime_sq = eccentricity_sq / (1 - eccentricity_sq)
    scale = 0.9996
    mu = (y / scale) / (semi_major * (1 - eccentricity_sq / 4 - 3 * eccentricity_sq**2 / 64 - 5 * eccentricity_sq**3 / 256))
    e1 = (1 - math.sqrt(1 - eccentricity_sq)) / (1 + math.sqrt(1 - eccentricity_sq))
    footprint = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + 151 * e1**3 / 96 * math.sin(6 * mu)
        + 1097 * e1**4 / 512 * math.sin(8 * mu)
    )
    sin_fp, cos_fp, tan_fp = math.sin(footprint), math.cos(footprint), math.tan(footprint)
    n1 = semi_major / math.sqrt(1 - eccentricity_sq * sin_fp**2)
    r1 = semi_major * (1 - eccentricity_sq) / (1 - eccentricity_sq * sin_fp**2) ** 1.5
    t1, c1 = tan_fp**2, eccentricity_prime_sq * cos_fp**2
    d = (x - 500_000) / (n1 * scale)
    latitude = footprint - (n1 * tan_fp / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * eccentricity_prime_sq) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * eccentricity_prime_sq - 3 * c1**2) * d**6 / 720
    )
    longitude = math.radians(-93) + (
        d - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * eccentricity_prime_sq + 24 * t1**2) * d**5 / 120
    ) / cos_fp
    return round(math.degrees(longitude), 7), round(math.degrees(latitude), 7)


def _driving_model(router: DrivingRouter | None, *, fallback: str) -> dict[str, Any]:
    if router is None:
        return {"provider": "estimate", "label": fallback}
    metadata = dict(router.metadata)
    provider = str(metadata.get("provider", "road router")).upper()
    metadata["label"] = f"{provider} {metadata.get('profile', 'driving')} / {metadata.get('datasetId', 'unversioned roads')}"
    return metadata


def _driving_metrics(
    home: dict[str, Any],
    work: dict[str, Any],
    router: DrivingRouter | None,
    *,
    fallback_speed_mps: float,
    fallback_circuity: float = 1.0,
) -> tuple[int, int]:
    direct_distance = max(1.0, math.dist((home["x"], home["y"]), (work["x"], work["y"])))
    if router is not None:
        route = router.route(_utm15_to_wgs84(home["x"], home["y"]), _utm15_to_wgs84(work["x"], work["y"]))
        return max(60, round(route.duration_seconds)), max(1, round(route.distance_metres))
    distance = direct_distance * fallback_circuity
    return max(60, round(distance / fallback_speed_mps)), max(1, round(distance))


def _build_voronoi_sites(config: WorldConfig, endpoints: Iterable[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    """Assign source locations to their nearest deterministic seed within 100 m.

    The resulting nearest-site partition is the point layer used by both native
    and cross-city demand. A fixed seed coordinate prevents chain-merging a
    dense downtown into one giant single-linkage component.
    """
    locations: dict[tuple[str, str], dict[str, Any]] = {}
    for endpoint in endpoints:
        key = (str(endpoint["tile_id"]), str(endpoint["block_id"]))
        row = locations.setdefault(key, {
            "key": key, "x": float(endpoint["x"]), "y": float(endpoint["y"]), "weight": 0,
        })
        row["weight"] += int(endpoint["mass"])

    radius = config.point_merge_distance_m
    clusters: list[dict[str, Any]] = []
    spatial: dict[tuple[str, int, int], list[int]] = {}
    assignment: dict[tuple[str, str], int] = {}
    for row in sorted(locations.values(), key=lambda item: (item["key"][0], item["x"], item["y"], item["key"][1])):
        owner = row["key"][0]
        gx, gy = math.floor(row["x"] / radius), math.floor(row["y"] / radius)
        candidates: list[tuple[float, int]] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for index in spatial.get((owner, gx + dx, gy + dy), []):
                    cluster = clusters[index]
                    distance = math.dist((row["x"], row["y"]), (cluster["seed_x"], cluster["seed_y"]))
                    if distance <= radius:
                        candidates.append((distance, index))
        if candidates:
            _, cluster_index = min(candidates, key=lambda item: (item[0], clusters[item[1]]["member_keys"][0]))
        else:
            cluster_index = len(clusters)
            clusters.append({
                "owner": owner, "seed_x": row["x"], "seed_y": row["y"],
                "sum_x": 0.0, "sum_y": 0.0, "weight": 0, "member_keys": [],
            })
            spatial.setdefault((owner, gx, gy), []).append(cluster_index)
        cluster = clusters[cluster_index]
        cluster["sum_x"] += row["x"] * row["weight"]
        cluster["sum_y"] += row["y"] * row["weight"]
        cluster["weight"] += row["weight"]
        cluster["member_keys"].append(row["key"])
        assignment[row["key"]] = cluster_index

    # Weighted centroids can move two initially separate seeds back within the
    # radius. Merge centroid-neighbor components until the final site set is
    # stable, so the published points themselves satisfy the 100 m rule. The
    # extra metre absorbs WGS84 serialization/projection rounding.
    separation_radius = radius + 1.0
    while True:
        parent = list(range(len(clusters)))

        def find(index: int) -> int:
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        def union(left: int, right: int) -> bool:
            left_root, right_root = find(left), find(right)
            if left_root == right_root:
                return False
            parent[max(left_root, right_root)] = min(left_root, right_root)
            return True

        centroid_grid: dict[tuple[str, int, int], list[int]] = {}
        changed = False
        for index, cluster in enumerate(clusters):
            x = cluster["sum_x"] / cluster["weight"]
            y = cluster["sum_y"] / cluster["weight"]
            gx, gy = math.floor(x / separation_radius), math.floor(y / separation_radius)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other_index in centroid_grid.get((cluster["owner"], gx + dx, gy + dy), []):
                        other = clusters[other_index]
                        other_xy = (other["sum_x"] / other["weight"], other["sum_y"] / other["weight"])
                        if math.dist((x, y), other_xy) < separation_radius:
                            changed = union(index, other_index) or changed
            centroid_grid.setdefault((cluster["owner"], gx, gy), []).append(index)
        if not changed:
            break
        merged: dict[int, dict[str, Any]] = {}
        for index, cluster in enumerate(clusters):
            root = find(index)
            target = merged.setdefault(root, {
                "owner": cluster["owner"], "seed_x": cluster["seed_x"], "seed_y": cluster["seed_y"],
                "sum_x": 0.0, "sum_y": 0.0, "weight": 0, "member_keys": [],
            })
            target["sum_x"] += cluster["sum_x"]
            target["sum_y"] += cluster["sum_y"]
            target["weight"] += cluster["weight"]
            target["member_keys"].extend(cluster["member_keys"])
        clusters = sorted(merged.values(), key=lambda cluster: (cluster["owner"], sorted(cluster["member_keys"])[0]))

    sites: list[dict[str, Any]] = []
    assignment = {}
    for index, cluster in enumerate(clusters):
        members = sorted(cluster["member_keys"])
        sites.append({
            "id": stable_id(
                "demand-site", config.clustering_version, config.point_merge_distance_m,
                cluster["owner"], members[0], members[-1], len(members), index,
            ),
            "tile_id": cluster["owner"],
            "x": cluster["sum_x"] / cluster["weight"],
            "y": cluster["sum_y"] / cluster["weight"],
        })
        for member in members:
            assignment[member] = index
    return {key: sites[index] for key, index in assignment.items()}


def _morton_4d(config: WorldConfig, home: dict[str, Any], work: dict[str, Any]) -> int:
    values = tuple(max(0, math.floor(value / config.native_cluster_cell_m)) for value in (home["x"], home["y"], work["x"], work["y"]))
    result = 0
    for bit in range(16):
        for dimension, value in enumerate(values):
            result |= ((value >> bit) & 1) << (bit * 4 + dimension)
    return result


def _aggregate_spatial_flows(config: WorldConfig, flows: Iterable[dict[str, Any]], sites: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate exact site pairs, then pack neighboring sparse OD flows to >=50."""
    exact: dict[tuple[tuple[str, ...], str, str], dict[str, Any]] = {}
    for flow in flows:
        home = sites[flow["home_key"]]
        work = sites[flow["work_key"]]
        partition = tuple(flow["partition"])
        key = (partition, home["id"], work["id"])
        row = exact.setdefault(key, {"partition": partition, "home": home, "work": work, "mass": 0})
        row["mass"] += int(flow["mass"])

    by_partition: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for row in exact.values():
        by_partition.setdefault(row["partition"], []).append(row)

    packed: list[dict[str, Any]] = []
    for partition, rows in sorted(by_partition.items()):
        ordered = sorted(rows, key=lambda row: (_morton_4d(config, row["home"], row["work"]), row["home"]["id"], row["work"]["id"]))
        groups: list[list[dict[str, Any]]] = []
        pending: list[dict[str, Any]] = []
        pending_mass = 0
        for row in ordered:
            pending.append(row)
            pending_mass += row["mass"]
            if pending_mass >= config.native_minimum_cohort_size:
                groups.append(pending)
                pending, pending_mass = [], 0
        if pending:
            if groups:
                groups[-1].extend(pending)
            else:
                groups.append(pending)

        for group in groups:
            mass = sum(row["mass"] for row in group)
            home_center = (
                sum(row["home"]["x"] * row["mass"] for row in group) / mass,
                sum(row["home"]["y"] * row["mass"] for row in group) / mass,
            )
            work_center = (
                sum(row["work"]["x"] * row["mass"] for row in group) / mass,
                sum(row["work"]["y"] * row["mass"] for row in group) / mass,
            )
            home = min((row["home"] for row in group), key=lambda site: (math.dist(home_center, (site["x"], site["y"])), site["id"]))
            work = min((row["work"] for row in group), key=lambda site: (math.dist(work_center, (site["x"], site["y"])), site["id"]))
            packed.append({"partition": partition, "home": home, "work": work, "mass": mass})

    # Snapping neighboring packs to shared Voronoi sites can produce the same
    # pair more than once. Keep the full combined mass; 50 is a floor, not cap.
    combined: dict[tuple[tuple[str, ...], str, str], dict[str, Any]] = {}
    for row in packed:
        key = (row["partition"], row["home"]["id"], row["work"]["id"])
        target = combined.setdefault(key, {**row, "mass": 0})
        target["mass"] += row["mass"]
    result: list[dict[str, Any]] = []
    for key in sorted(combined):
        row = combined[key]
        part_count = max(1, math.ceil(row["mass"] / config.maximum_cohort_size))
        base_size, remainder = divmod(row["mass"], part_count)
        for part in range(part_count):
            result.append({**row, "mass": base_size + (1 if part < remainder else 0), "part": part})
    return result


def _native_demand(config: WorldConfig, views: list[dict[str, Any]], driving_router: DrivingRouter | None = None) -> dict[str, Any]:
    """Materialize local-only Subway Builder demand on shared spatial sites."""
    local = [view for view in views if view["classification"] == "LOCAL"]
    if not local:
        return {"points": [], "pops": []}
    tile_id = str(local[0]["tile_id"])
    endpoints = []
    flows = []
    for view in local:
        mass = int(view["mass"])
        home_key = (tile_id, str(view["home_block"]))
        work_key = (tile_id, str(view["work_block"]))
        endpoints.extend([
            {"tile_id": tile_id, "block_id": home_key[1], "x": view["home_x"], "y": view["home_y"], "mass": mass},
            {"tile_id": tile_id, "block_id": work_key[1], "x": view["work_x"], "y": view["work_y"], "mass": mass},
        ])
        flows.append({"home_key": home_key, "work_key": work_key, "mass": mass, "partition": (tile_id,)})
    site_map = _build_voronoi_sites(config, endpoints)
    aggregated = _aggregate_spatial_flows(config, flows, site_map)

    point_map: dict[str, dict[str, Any]] = {}
    pops: list[dict[str, Any]] = []
    for index, row in enumerate(aggregated):
        home, work, mass = row["home"], row["work"], row["mass"]
        pop_id = stable_id("native-pop", config.clustering_version, tile_id, home["id"], work["id"], index)
        driving_seconds, driving_distance = _driving_metrics(
            home, work, driving_router, fallback_speed_mps=LOCAL_FALLBACK_SPEED_MPS,
        )
        pops.append({"id": pop_id, "size": mass, "residenceId": home["id"], "jobId": work["id"], "drivingSeconds": driving_seconds, "drivingDistance": driving_distance})
        for site in (home, work):
            point_map.setdefault(site["id"], {"id": site["id"], "location": list(_utm15_to_wgs84(site["x"], site["y"])), "jobs": 0, "residents": 0, "popIds": []})
        point_map[home["id"]]["residents"] += mass
        point_map[home["id"]]["popIds"].append(pop_id)
        point_map[work["id"]]["jobs"] += mass
        if work["id"] != home["id"]:
            point_map[work["id"]]["popIds"].append(pop_id)
    return {"points": [point_map[key] for key in sorted(point_map)], "pops": sorted(pops, key=lambda pop: pop["id"])}


def _write_gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
        output.write(canonical_json(value))


def _runtime_file(path: str, files: dict[str, dict[str, Any]], *, encoding: str, role: str) -> dict[str, Any]:
    """Stable mod-facing descriptor for a world-runtime artifact.

    Keep this explicit rather than asking the mod to infer meaning from the
    generic assets array.  `path` values are deliberately tile-relative.
    """
    return {"path": path, "bytes": files[path]["bytes"], "sha256": files[path]["sha256"], "encoding": encoding, "role": role}


def _cross_commute_summary(config: WorldConfig, cohorts: Iterable[Cohort], tile_id: str) -> dict[str, Any]:
    """Build the small runtime handoff view without exposing per-cohort trips.

    Detailed projections remain in cohorts.json.gz/trips.bin for provenance and
    offline analysis.  The live JS mod consumes only these deterministic
    (origin, destination, gateway) buckets plus gateway definitions.
    """
    totals: dict[tuple[str, str, str], int] = {}
    for cohort in cohorts:
        if tile_id not in (cohort.home_tile, cohort.work_tile) or cohort.home_tile == cohort.work_tile:
            continue
        if not cohort.home_tile or not cohort.work_tile or not cohort.gateway_id:
            raise ValueError(f"cross-tile cohort has incomplete routing: {cohort.id}")
        key = (cohort.home_tile, cohort.work_tile, cohort.gateway_id)
        totals[key] = totals.get(key, 0) + cohort.mass
    buckets = [{
        "id": stable_id("cross-commute", config.clustering_version, *key),
        "homeTileId": key[0], "workTileId": key[1], "gatewayId": key[2], "mass": mass,
        "defaultTravelSeconds": DEFAULT_CROSS_COMMUTE_TRAVEL_SECONDS,
        "defaultCapacityPerHour": DEFAULT_CROSS_COMMUTE_CAPACITY_PER_HOUR,
    } for key, mass in sorted(totals.items())]
    return {"schemaVersion": 1, "tileId": tile_id, "buckets": buckets}


def _cross_demand_view(config: WorldConfig, cohorts: Iterable[Cohort], tile_id: str, driving_router: DrivingRouter | None = None) -> dict[str, Any]:
    """Compact cross-city demand using the same shared spatial sites."""
    cross = sorted((cohort for cohort in cohorts if cohort.home_tile != cohort.work_tile), key=lambda cohort: cohort.id)
    endpoints = []
    flows = []
    for cohort in cross:
        if not cohort.home_tile or not cohort.work_tile or not cohort.gateway_id:
            raise ValueError(f"cross-tile cohort has incomplete viewer data: {cohort.id}")
        home_key = (cohort.home_tile, cohort.home_block)
        work_key = (cohort.work_tile, cohort.work_block)
        endpoints.extend([
            {"tile_id": cohort.home_tile, "block_id": cohort.home_block, "x": cohort.home_x, "y": cohort.home_y, "mass": cohort.mass},
            {"tile_id": cohort.work_tile, "block_id": cohort.work_block, "x": cohort.work_x, "y": cohort.work_y, "mass": cohort.mass},
        ])
        flows.append({
            "home_key": home_key, "work_key": work_key, "mass": cohort.mass,
            "partition": (cohort.home_tile, cohort.work_tile, cohort.gateway_id),
        })
    site_map = _build_voronoi_sites(config, endpoints)
    aggregated = _aggregate_spatial_flows(config, flows, site_map)

    gateway_ids = sorted({cohort.gateway_id for cohort in cross if cohort.gateway_id})
    gateway_index = {gateway_id: index for index, gateway_id in enumerate(gateway_ids)}
    point_mass: dict[str, dict[str, Any]] = {}
    pop_rows: list[tuple[str, int, str, str, str, float, float, int, int]] = []
    for index, row in enumerate(aggregated):
        home, work, mass = row["home"], row["work"], row["mass"]
        gateway_id = row["partition"][2]
        pop_id = stable_id("cross-pop", config.clustering_version, home["id"], work["id"], gateway_id, index)
        driving_seconds, driving_distance = _driving_metrics(
            home, work, driving_router,
            fallback_speed_mps=CROSS_FALLBACK_SPEED_MPS,
            fallback_circuity=CROSS_FALLBACK_CIRCUITY,
        )
        home_departure, work_departure = _commute_departures(pop_id)
        pop_rows.append((
            pop_id, mass, home["id"], work["id"], gateway_id,
            home_departure, work_departure, driving_seconds, driving_distance,
        ))
        for site in (home, work):
            point_mass.setdefault(site["id"], {**site, "residents": 0, "workers": 0})
        point_mass[home["id"]]["residents"] += mass
        point_mass[work["id"]]["workers"] += mass

    point_ids = sorted(point_mass)
    point_index = {point_id: index for index, point_id in enumerate(point_ids)}
    points = []
    for point_id in point_ids:
        site = point_mass[point_id]
        longitude, latitude = _utm15_to_wgs84(site["x"], site["y"])
        points.append([point_id, round(longitude, 6), round(latitude, 6), site["tile_id"], site["residents"], site["workers"]])
    pops = [
        [
            pop_id, mass, point_index[home_id], point_index[work_id], gateway_index[gateway_id],
            home_departure, work_departure, driving_seconds, driving_distance,
        ]
        for pop_id, mass, home_id, work_id, gateway_id, home_departure, work_departure, driving_seconds, driving_distance in pop_rows
    ]
    return {
        "schemaVersion": 1,
        "tileId": tile_id,
        "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
        "popFields": [
            "id", "mass", "homePoint", "workPoint", "gateway",
            "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance",
        ],
        "drivingModel": _driving_model(driving_router, fallback="straight-line ×1.3 at 40 km/h"),
        "gateways": gateway_ids,
        "points": points,
        "pops": pops,
    }


def package_tiles(
    config: WorldConfig,
    cohorts: Iterable[Cohort],
    destination: str | Path,
    *,
    source_hashes: dict[str, str] | None = None,
    driving_router: DrivingRouter | None = None,
) -> dict[str, Any]:
    """Emit compact, reproducible per-tile demand packages and manifests."""
    destination = Path(destination)
    all_cohorts = list(cohorts)
    aggregation_config = {
        "schema_version": config.schema_version,
        "clustering_version": config.clustering_version,
        "maximum_cohort_size": config.maximum_cohort_size,
        "native_minimum_cohort_size": config.native_minimum_cohort_size,
        "native_cluster_cell_m": config.native_cluster_cell_m,
        "point_merge_distance_m": config.point_merge_distance_m,
        "driving_model": _driving_model(driving_router, fallback="geometric fallback"),
    }
    build_hash = __import__("hashlib").sha256(canonical_json({"config": aggregation_config, "cohorts": [cohort.__dict__ for cohort in all_cohorts]})).hexdigest()
    world_manifest: dict[str, Any] = {"schema_version": config.schema_version, "crs": config.crs, "data_vintage": config.data_vintage, "build_hash": build_hash, "source_hashes": source_hashes or {}, "tiles": {}}
    for tile in config.tiles:
        tile_dir = destination / tile.id
        views = projections(config, all_cohorts, tile.id)
        demand = _native_demand(config, views, driving_router)
        demand_path = tile_dir / "demand_data.json.gz"
        _write_gzip_json(demand_path, demand)
        _write_gzip_json(tile_dir / "cohorts.json.gz", {"tile_id": tile.id, "build_hash": build_hash, "cohorts": views})
        # The experimental runtime gets deterministic compact JSON payloads;
        # extensions deliberately leave room for a later binary codec.
        runtime_gateways = [{
            **gateway.__dict__,
            "location": list(_utm15_to_wgs84(gateway.x, gateway.y)),
            "capacityPerHour": DEFAULT_CROSS_COMMUTE_CAPACITY_PER_HOUR,
        } for gateway in config.gateways]
        for filename, value in (("nodes.bin", []), ("trips.bin", views), ("gates.bin", runtime_gateways)):
            serialized = [item.__dict__ if hasattr(item, "__dict__") else item for item in value]
            (tile_dir / filename).parent.mkdir(parents=True, exist_ok=True)
            (tile_dir / filename).write_bytes(canonical_json(serialized))
        write_json(tile_dir / "cross_commutes.json", _cross_commute_summary(config, all_cohorts, tile.id))
        _write_gzip_json(tile_dir / "cross_demand.json.gz", _cross_demand_view(config, all_cohorts, tile.id, driving_router))
        counts: dict[str, int] = {}
        for view in views:
            counts[view["classification"]] = counts.get(view["classification"], 0) + int(view["mass"])
        artifact_names = ["demand_data.json.gz", "cohorts.json.gz", "nodes.bin", "trips.bin", "gates.bin", "cross_commutes.json", "cross_demand.json.gz"]
        artifact_names.extend(name for name in ("buildings_index.bin.gz", "roads.geojson.gz", "runways_taxiways.geojson.gz") if (tile_dir / name).exists())
        files = {name: {"bytes": (tile_dir / name).stat().st_size, "sha256": sha256_file(tile_dir / name)} for name in artifact_names}
        reproducibility_manifest = {"schema_version": config.schema_version, "tile_id": tile.id, "build_hash": build_hash, "counts": counts, "files": files, "source_hashes": source_hashes or {}}
        write_json(tile_dir / "build-manifest.json", reproducibility_manifest)
        # manifest.json is the mod-facing contract. The detailed snake_case
        # build-manifest remains the reproducibility record.
        runtime_manifest = {
            "schemaVersion": 1,
            "tileId": tile.id,
            "cityCode": tile.id,
            "buildHash": build_hash,
            "dataFiles": {
                **{"demandData": "demand_data.json.gz"},
                **({"buildingsIndex": "buildings_index.bin.gz"} if (tile_dir / "buildings_index.bin.gz").exists() else {}),
                **({"roads": "roads.geojson.gz"} if (tile_dir / "roads.geojson.gz").exists() else {}),
                **({"runwaysTaxiways": "runways_taxiways.geojson.gz"} if (tile_dir / "runways_taxiways.geojson.gz").exists() else {}),
            },
            "runtimeFiles": {
                "schemaVersion": 1,
                "crossCommutes": _runtime_file("cross_commutes.json", files, encoding="canonical-json", role="cross-tile-commute-summary"),
                "crossDemand": _runtime_file("cross_demand.json.gz", files, encoding="gzip-json", role="cross-tile-demand-viewer"),
                "gates": _runtime_file("gates.bin", files, encoding="canonical-json", role="gateway-definitions"),
            },
            "assets": [{"path": name, **metadata} for name, metadata in sorted(files.items())],
        }
        write_json(tile_dir / "manifest.json", runtime_manifest)
        world_manifest["tiles"][tile.id] = {"build_manifest": f"{tile.id}/build-manifest.json", "runtime_manifest": f"{tile.id}/manifest.json", "demand_bytes": files["demand_data.json.gz"]["bytes"]}
    write_json(destination / "world-manifest.json", world_manifest)
    return world_manifest
