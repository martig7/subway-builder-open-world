#!/usr/bin/env python3
"""Compile the 47-prefecture Japan demand evidence into one runtime ledger.

This module deliberately consumes only geography-specific evidence and the
World catalog. It contains no per-prefecture branches: Tokyo and Kanagawa use
their already boundary-constrained sites, while every other prefecture uses the
same validated candidate-site contract emitted by ``estat_japan_prefecture``.
Road enrichment is a separate, resumable stage and replaces the deterministic
geometric estimates written here.
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import hashlib
import json
import math
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import Point

from .estat_japan_prefecture import load_prefecture_boundary


COMPILER_VERSION = "estat-japan-national-package-v1"
SPECIAL_TILE_IDS = {"13": "JP_TOKYO_MAINLAND", "14": "JP_KANAGAWA_MAINLAND"}


def tile_id(pref_code: str) -> str:
    return SPECIAL_TILE_IDS.get(pref_code, f"JP_PREF_{pref_code}")


@dataclass(frozen=True)
class Site:
    id: str
    longitude: float
    latitude: float
    home_weight: int
    job_weight: int
    source_pref: str = ""
    owner_pref: str = ""
    force_cross: bool = False


@dataclass(frozen=True)
class CrossRecord:
    id: str
    mass: int
    home: Site
    work: Site
    source_origin_pref: str
    source_destination_pref: str


class Progress:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.started = time.perf_counter()
        self.sequence = 0

    def emit(self, stage: str, status: str, **details: Any) -> None:
        self.sequence += 1
        event = {
            "event": "japan-package-progress",
            "sequence": self.sequence,
            "stage": stage,
            "status": status,
            "elapsedSeconds": round(time.perf_counter() - self.started, 3),
            "capturedAt": datetime.now(UTC).isoformat(),
            **details,
        }
        print(json.dumps(event, ensure_ascii=True, sort_keys=True), flush=True)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8", newline="\n") as output:
                output.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")


def write_gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as output:
            output.write(encoded)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def chunk_mass(mass: int, maximum: int = 200) -> Iterable[int]:
    remaining = mass
    while remaining:
        amount = min(maximum, remaining)
        yield amount
        remaining -= amount


def proportional_allocations(weights: list[int], total: int) -> list[int]:
    if total < 0 or not weights:
        raise ValueError("Allocation needs non-negative mass and at least one site")
    normalized = [max(0, int(value)) for value in weights]
    weight_total = sum(normalized)
    if weight_total == 0:
        normalized = [1] * len(normalized)
        weight_total = len(normalized)
    result: list[int] = []
    remainders: list[tuple[int, int]] = []
    assigned = 0
    for index, weight in enumerate(normalized):
        amount, remainder = divmod(total * weight, weight_total)
        result.append(amount)
        remainders.append((remainder, index))
        assigned += amount
    for _, index in sorted(remainders, key=lambda row: (-row[0], row[1]))[: total - assigned]:
        result[index] += 1
    if sum(result) != total:
        raise AssertionError(f"allocation did not conserve {total}")
    return result


class WeightedPicker:
    def __init__(self, sites: list[Site], field: str) -> None:
        self.sites = sites
        self.cumulative: list[int] = []
        total = 0
        for site in sites:
            total += max(0, int(getattr(site, field)))
            self.cumulative.append(total)
        if total == 0:
            self.cumulative = list(range(1, len(sites) + 1))
            total = len(sites)
        self.total = total

    def pick(self, seed: str) -> Site:
        target = int(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16], 16) % self.total
        return self.sites[bisect.bisect_right(self.cumulative, target)]


def road_estimate(home: Site, work: Site) -> tuple[int, int]:
    mean_latitude = math.radians((home.latitude + work.latitude) / 2)
    dx = (home.longitude - work.longitude) * 111_320 * math.cos(mean_latitude)
    dy = (home.latitude - work.latitude) * 110_574
    distance = max(1, round(math.hypot(dx, dy)))
    return max(60, round(distance / 13.4)), distance


def _candidate_sites(evidence_dir: Path, pref_code: str) -> list[Site]:
    candidates = read_json(evidence_dir / "demand-site-candidates.geojson")["features"]
    jobs = read_json(evidence_dir / "job-mesh-500m.geojson")["features"]
    coordinates = np.asarray([feature["geometry"]["coordinates"] for feature in candidates], dtype=np.float64)
    if not len(coordinates):
        raise ValueError(f"No demand sites in {evidence_dir}")
    # Longitude is scaled near the prefecture's mean latitude so nearest-site
    # assignment is metric enough without selecting a special CRS per island.
    longitude_scale = math.cos(math.radians(float(coordinates[:, 1].mean())))
    tree = cKDTree(np.column_stack((coordinates[:, 0] * longitude_scale, coordinates[:, 1])))
    job_weights = np.zeros(len(candidates), dtype=np.int64)
    if jobs:
        job_coordinates = np.asarray([feature["geometry"]["coordinates"] for feature in jobs], dtype=np.float64)
        _, nearest = tree.query(np.column_stack((job_coordinates[:, 0] * longitude_scale, job_coordinates[:, 1])), k=1)
        for index, feature in zip(nearest.tolist(), jobs, strict=True):
            job_weights[index] += int(feature["properties"].get("jobs", 0))
    return [
        Site(
            id=str(feature["properties"]["id"]),
            longitude=float(feature["geometry"]["coordinates"][0]),
            latitude=float(feature["geometry"]["coordinates"][1]),
            home_weight=int(feature["properties"].get("commuters", 0)),
            job_weight=int(job_weights[index]),
            source_pref=pref_code,
            owner_pref=pref_code,
        )
        for index, feature in enumerate(candidates)
    ]


def _compatible_sites(demand_root: Path, pref_code: str) -> list[Site]:
    value = read_gzip_json(demand_root / "tiles" / tile_id(pref_code) / "demand_data.json.gz")
    return [
        Site(
            id=str(point["id"]),
            longitude=float(point["location"][0]),
            latitude=float(point["location"][1]),
            home_weight=int(point.get("residents", 0)),
            job_weight=int(point.get("jobs", 0)),
            source_pref=pref_code,
            owner_pref=pref_code,
        )
        for point in value["points"]
    ]


def _load_flows(evidence_root: Path, compatible_evidence: Path) -> tuple[dict[tuple[str, str], int], dict[str, int]]:
    pair_mass: dict[tuple[str, str], int] = defaultdict(int)
    accepted_by_origin: dict[str, int] = defaultdict(int)
    compatible_flows = read_json(compatible_evidence / "municipality-od.json")["flows"]
    for pref_number in range(1, 48):
        pref_code = f"{pref_number:02d}"
        flows = compatible_flows if pref_code in SPECIAL_TILE_IDS else read_json(evidence_root / tile_id(pref_code) / "municipality-od.json")["flows"]
        for flow in flows:
            origin_code = str(flow.get("originMunicipalityCode", ""))[:2]
            if origin_code != pref_code:
                continue
            destination_code = str(flow.get("destinationMunicipalityCode", ""))[:2]
            if destination_code not in {f"{value:02d}" for value in range(1, 48)}:
                continue
            mass = int(flow.get("commutersAndStudents", 0))
            if mass <= 0:
                continue
            pair_mass[(origin_code, destination_code)] += mass
            accepted_by_origin[origin_code] += mass
    return dict(pair_mass), dict(accepted_by_origin)


def _compile_native(tile: str, pref_code: str, sites: list[Site], local_mass: int) -> tuple[dict[str, Any], list[CrossRecord], dict[str, int]]:
    home = proportional_allocations([site.home_weight for site in sites], local_mass)
    jobs = proportional_allocations([site.job_weight for site in sites], local_mass)
    points: dict[str, dict[str, Any]] = {}
    pops: list[dict[str, Any]] = []
    diverted: list[CrossRecord] = []
    home_rows = [[index, mass] for index, mass in enumerate(home) if mass]
    job_rows = [[index, mass] for index, mass in enumerate(jobs) if mass]
    home_index = job_index = cohort_index = 0
    while home_index < len(home_rows) and job_index < len(job_rows):
        home_site_index, home_remaining = home_rows[home_index]
        job_site_index, job_remaining = job_rows[job_index]
        amount = min(home_remaining, job_remaining)
        residence = sites[home_site_index]
        workplace = sites[job_site_index]
        seconds, distance = road_estimate(residence, workplace)
        for mass in chunk_mass(amount):
            if residence.force_cross or workplace.force_cross:
                pop_id = f"jp-national-cross-boundary-audit-{pref_code}-{cohort_index:07d}"
                diverted.append(CrossRecord(pop_id, mass, residence, workplace, pref_code, pref_code))
                cohort_index += 1
                continue
            pop_id = f"jp-national-local-{tile.lower()}-{cohort_index:07d}"
            cohort_index += 1
            pops.append({"id": pop_id, "size": mass, "residenceId": residence.id, "jobId": workplace.id, "drivingSeconds": seconds, "drivingDistance": distance})
            home_point = points.setdefault(residence.id, {"id": residence.id, "location": [residence.longitude, residence.latitude], "jobs": 0, "residents": 0, "popIds": []})
            work_point = points.setdefault(workplace.id, {"id": workplace.id, "location": [workplace.longitude, workplace.latitude], "jobs": 0, "residents": 0, "popIds": []})
            home_point["residents"] += mass
            work_point["jobs"] += mass
            home_point["popIds"].append(pop_id)
            if work_point is not home_point:
                work_point["popIds"].append(pop_id)
        home_rows[home_index][1] -= amount
        job_rows[job_index][1] -= amount
        if home_rows[home_index][1] == 0:
            home_index += 1
        if job_rows[job_index][1] == 0:
            job_index += 1
    if home_index != len(home_rows) or job_index != len(job_rows):
        raise AssertionError(f"{tile} native allocation did not conserve mass")
    native_mass = sum(int(pop["size"]) for pop in pops)
    diverted_mass = sum(record.mass for record in diverted)
    return {"points": [points[key] for key in sorted(points)], "pops": pops}, diverted, {"sourceLocalMass": local_mass, "nativeMass": native_mass, "divertedMass": diverted_mass, "pointCount": len(points), "cohortCount": len(pops), "divertedCohortCount": len(diverted)}


def compile_japan(
    *,
    world_root: Path,
    evidence_root: Path,
    compatible_evidence: Path,
    compatible_demand_root: Path,
    output_root: Path,
    progress_path: Path | None = None,
) -> dict[str, Any]:
    progress = Progress(progress_path)
    catalog = read_json(world_root / "geography" / "tile-views.json")
    codes = [str(tile["prefCode"]) for tile in catalog["tiles"]]
    if codes != [f"{value:02d}" for value in range(1, 48)]:
        raise ValueError("Japan catalog must contain prefecture codes 01..47 in order")
    progress.emit("load", "started", prefectureCount=len(codes))
    _, boundaries, boundary_index, _ = load_prefecture_boundary(set(codes), world_root / "geography" / "prefectures.geojson")
    sites_by_pref: dict[str, list[Site]] = {}
    ownership_audit: dict[str, dict[str, Any]] = {}
    deferred_site_ids: set[str] = set()
    for pref_code in codes:
        sites = _compatible_sites(compatible_demand_root, pref_code) if pref_code in SPECIAL_TILE_IDS else _candidate_sites(evidence_root / tile_id(pref_code), pref_code)
        if not sites:
            raise ValueError(f"No sites for prefecture {pref_code}")
        owner_counts: dict[str, int] = defaultdict(int)
        no_owner: list[str] = []
        owned_sites = []
        for site in sites:
            point = Point(site.longitude, site.latitude)
            if boundaries[pref_code].covers(point):
                owner_pref = pref_code
                force_cross = False
            else:
                hits = boundary_index.all_tree.query(point, predicate="covered_by")
                if len(hits):
                    owner_pref = min(boundary_index.all_codes[int(index)] for index in hits)
                else:
                    # No rendered tile owns this coastal point. Keep its exact
                    # source location but force cohorts through the aggregate
                    # ledger so native building lookup cannot snap it into a
                    # giant boundary-edge demand dot.
                    owner_pref = pref_code
                    no_owner.append(site.id)
                    deferred_site_ids.add(site.id)
                force_cross = True
            owner_counts[owner_pref] += 1
            owned_sites.append(Site(site.id, site.longitude, site.latitude, site.home_weight, site.job_weight, pref_code, owner_pref, force_cross))
        sites = owned_sites
        ownership_audit[pref_code] = {"ownerCounts": dict(sorted(owner_counts.items())), "noOwnerCount": len(no_owner)}
        progress.emit("site-ownership", "complete", prefCode=pref_code, tileId=tile_id(pref_code), **ownership_audit[pref_code])
        sites_by_pref[pref_code] = sites
        forced_count = sum(1 for site in sites if site.force_cross)
        progress.emit("load-sites", "complete", prefCode=pref_code, tileId=tile_id(pref_code), siteCount=len(sites), nativeOutsideRenderedBoundary=0, forcedCrossSiteCount=forced_count, crossTileOwnerCount=sum(count for owner, count in owner_counts.items() if owner != pref_code), deferredOutsideRenderCount=len(no_owner))
    pair_mass, accepted_by_origin = _load_flows(evidence_root, compatible_evidence)
    progress.emit("load-flows", "complete", directedPairCount=len(pair_mass), acceptedMass=sum(pair_mass.values()))

    native_reports = []
    cross_records: list[CrossRecord] = []
    for pref_code in codes:
        tile = tile_id(pref_code)
        native, diverted, report = _compile_native(tile, pref_code, sites_by_pref[pref_code], pair_mass.get((pref_code, pref_code), 0))
        cross_records.extend(diverted)
        tile_root = output_root / "tiles" / tile
        demand_path = tile_root / "demand_data.json.gz"
        write_gzip_json(demand_path, native)
        write_json(tile_root / "manifest.json", {"schemaVersion": 1, "tileId": tile, "cityCode": tile, "dataFiles": {"demandData": "demand_data.json.gz"}, "sha256": sha256(demand_path)})
        native_reports.append({"prefCode": pref_code, "tileId": tile, **report})
        progress.emit("native-demand", "complete", prefCode=pref_code, tileId=tile, **report)

    home_pickers = {code: WeightedPicker(sites, "home_weight") for code, sites in sites_by_pref.items()}
    job_pickers = {code: WeightedPicker(sites, "job_weight") for code, sites in sites_by_pref.items()}
    cross_points: dict[str, dict[str, Any]] = {}
    for origin_code, destination_code in sorted(pair_mass):
        if origin_code == destination_code:
            continue
        mass = pair_mass[(origin_code, destination_code)]
        cohort_count = 0
        for cohort_count, cohort_mass in enumerate(chunk_mass(mass), start=1):
            seed = f"{origin_code}:{destination_code}:{cohort_count}"
            home_site = home_pickers[origin_code].pick(f"home:{seed}")
            work_site = job_pickers[destination_code].pick(f"work:{seed}")
            cross_records.append(CrossRecord(f"jp-national-cross-{origin_code}-{destination_code}-{cohort_count:06d}", cohort_mass, home_site, work_site, origin_code, destination_code))
        progress.emit("cross-demand", "complete", originPrefCode=origin_code, destinationPrefCode=destination_code, mass=mass, cohortCount=cohort_count)

    pair_records: dict[tuple[str, str], list[CrossRecord]] = defaultdict(list)
    for record in cross_records:
        pair_records[(record.home.owner_pref, record.work.owner_pref)].append(record)
    catalog_by_pref = {str(tile["prefCode"]): tile for tile in catalog["tiles"]}
    gateways: list[dict[str, Any]] = []
    buckets: list[dict[str, Any]] = []
    gateway_indexes: dict[tuple[str, str], int] = {}
    for owner_pair, records in sorted(pair_records.items()):
        home_owner, work_owner = owner_pair
        pair_total = sum(record.mass for record in records)
        home_view = catalog_by_pref[home_owner]["initialView"]
        work_view = catalog_by_pref[work_owner]["initialView"]
        gateway_id = f"jp-pref-{home_owner}-{work_owner}"
        gateway_indexes[owner_pair] = len(gateways)
        gateways.append({"id": gateway_id, "location": [(home_view["longitude"] + work_view["longitude"]) / 2, (home_view["latitude"] + work_view["latitude"]) / 2], "capacityPerHour": max(10_000, pair_total)})
        buckets.append({"id": f"jp-national-{home_owner}-{work_owner}", "homeTileId": tile_id(home_owner), "workTileId": tile_id(work_owner), "gatewayId": gateway_id, "mass": pair_total, "defaultTravelSeconds": road_estimate(records[0].home, records[0].work)[0], "defaultCapacityPerHour": max(10_000, pair_total)})

    cross_pops: list[list[Any]] = []
    for record in cross_records:
        seconds, distance = road_estimate(record.home, record.work)
        for site, residents, workers in ((record.home, record.mass, 0), (record.work, 0, record.mass)):
            point = cross_points.setdefault(site.id, {"id": site.id, "longitude": site.longitude, "latitude": site.latitude, "tileId": tile_id(site.owner_pref), "residents": 0, "workers": 0})
            point["residents"] += residents
            point["workers"] += workers
        cross_pops.append([record.id, record.mass, record.home.id, record.work.id, gateway_indexes[(record.home.owner_pref, record.work.owner_pref)], "07:30", "17:30", seconds, distance])

    point_ids = sorted(cross_points)
    point_indexes = {point_id: index for index, point_id in enumerate(point_ids)}
    encoded_pops = [[row[0], row[1], point_indexes[row[2]], point_indexes[row[3]], *row[4:]] for row in cross_pops]
    cross_demand = {
        "schemaVersion": 1,
        "tileId": None,
        "pointFields": ["id", "longitude", "latitude", "tileId", "residents", "workers"],
        "popFields": ["id", "mass", "homePoint", "workPoint", "gateway", "homeDepartureTime", "workDepartureTime", "drivingSeconds", "drivingDistance"],
        "drivingModel": {"provider": "geometric-prefecture-seed-v1", "label": "pending generated-road enrichment"},
        "gateways": [gateway["id"] for gateway in gateways],
        "points": [[cross_points[key][field] for field in ("id", "longitude", "latitude", "tileId", "residents", "workers")] for key in point_ids],
        "pops": encoded_pops,
    }
    pair_inventory = [[origin, destination, mass] for (origin, destination), mass in sorted(pair_mass.items())]
    pair_hash = hashlib.sha256(json.dumps(pair_inventory, separators=(",", ":")).encode()).hexdigest()
    commute_catalog = {"schemaVersion": 1, "buildHash": f"{COMPILER_VERSION}:{pair_hash}", "buckets": buckets, "gateways": gateways}
    world_output = output_root / "world"
    write_gzip_json(world_output / "cross_demand.json.gz", cross_demand)
    write_json(world_output / "cross_commutes.json", commute_catalog)
    report = {
        "schemaVersion": 1,
        "compilerVersion": COMPILER_VERSION,
        "worldId": catalog["worldId"],
        "tileCount": len(codes),
        "native": native_reports,
        "directedPairCount": len(pair_mass),
        "acceptedMass": sum(pair_mass.values()),
        "acceptedByOrigin": accepted_by_origin,
        "sourceLocalMass": sum(value for (origin, destination), value in pair_mass.items() if origin == destination),
        "nativeMass": sum(row["nativeMass"] for row in native_reports),
        "boundaryAuditDivertedMass": sum(row["divertedMass"] for row in native_reports),
        "crossMass": sum(record.mass for record in cross_records),
        "crossPointCount": len(point_ids),
        "crossCohortCount": len(encoded_pops),
        "nativeOutsideRenderedBoundary": 0,
        "crossOutsideRenderedBoundaryPointCount": sum(1 for point_id in cross_points if point_id in deferred_site_ids),
        "ownershipAudit": ownership_audit,
        "routingStatus": "geometric-estimates-written; generated-road enrichment-required",
    }
    write_json(output_root / "reports" / "japan-national-demand.json", report)
    progress.emit("package-demand", "complete", **{key: report[key] for key in ("tileCount", "acceptedMass", "nativeMass", "boundaryAuditDivertedMass", "crossMass", "crossCohortCount")})
    return report


def main() -> None:
    repository_root = Path(__file__).resolve().parents[4]
    parser = argparse.ArgumentParser()
    parser.add_argument("--world-root", type=Path, default=repository_root / "worlds" / "japan")
    parser.add_argument("--evidence-root", type=Path, default=repository_root / "map-creator" / "data" / "artifacts" / "japan-prefecture-demand-v2")
    parser.add_argument("--compatible-evidence", type=Path, default=repository_root / "prototype" / "japan" / "generated" / "tokyo-kanagawa-test")
    parser.add_argument("--compatible-demand-root", type=Path, default=repository_root / "prototype" / "tokyo-kanagawa" / "generated" / "demand")
    parser.add_argument("--output-root", type=Path, default=repository_root / "prototype" / "japan" / "generated" / "demand")
    parser.add_argument("--progress-jsonl", type=Path)
    args = parser.parse_args()
    report = compile_japan(
        world_root=args.world_root,
        evidence_root=args.evidence_root,
        compatible_evidence=args.compatible_evidence,
        compatible_demand_root=args.compatible_demand_root,
        output_root=args.output_root,
        progress_path=args.progress_jsonl,
    )
    print(json.dumps({"valid": True, **{key: report[key] for key in ("tileCount", "acceptedMass", "nativeMass", "boundaryAuditDivertedMass", "crossMass", "crossCohortCount")}}, sort_keys=True))


if __name__ == "__main__":
    main()
