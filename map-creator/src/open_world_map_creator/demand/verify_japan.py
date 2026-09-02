#!/usr/bin/env python3
"""Independently verify a generated Japan national demand package."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

from shapely.geometry import Point, shape


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(world_root: Path, demand_root: Path) -> dict[str, Any]:
    catalog = read_json(world_root / "geography" / "tile-views.json")
    selected = [tile for tile in catalog["tiles"] if tile.get("status") == "selected"]
    boundary_source = read_json(world_root / "geography" / "prefectures.geojson")
    boundaries = {str(feature["properties"]["pref_code"]): shape(feature["geometry"]) for feature in boundary_source["features"]}
    native_mass = 0
    native_points = 0
    native_cohorts = 0
    outside = 0
    for tile in selected:
        tile_root = demand_root / "tiles" / tile["id"]
        demand_path = tile_root / "demand_data.json.gz"
        manifest = read_json(tile_root / "manifest.json")
        if manifest["tileId"] != tile["id"] or manifest["sha256"] != sha256(demand_path):
            raise ValueError(f"Manifest mismatch for {tile['id']}")
        demand = read_gzip_json(demand_path)
        point_ids = [str(point["id"]) for point in demand["points"]]
        pop_ids = [str(pop["id"]) for pop in demand["pops"]]
        if len(point_ids) != len(set(point_ids)) or len(pop_ids) != len(set(pop_ids)):
            raise ValueError(f"Duplicate native IDs in {tile['id']}")
        point_id_set = set(point_ids)
        pop_id_set = set(pop_ids)
        for point in demand["points"]:
            if len(point["popIds"]) != len(set(point["popIds"])) or not set(point["popIds"]) <= pop_id_set:
                raise ValueError(f"Invalid point-to-pop references in {tile['id']}:{point['id']}")
            if not boundaries[tile["prefCode"]].covers(Point(*point["location"])):
                outside += 1
        for pop in demand["pops"]:
            if pop["residenceId"] not in point_id_set or pop["jobId"] not in point_id_set:
                raise ValueError(f"Invalid native endpoint in {tile['id']}:{pop['id']}")
            if int(pop["size"]) <= 0 or int(pop["drivingSeconds"]) <= 0 or int(pop["drivingDistance"]) <= 0:
                raise ValueError(f"Invalid native cohort metrics in {tile['id']}:{pop['id']}")
        pop_mass = sum(int(pop["size"]) for pop in demand["pops"])
        if sum(int(point["residents"]) for point in demand["points"]) != pop_mass:
            raise ValueError(f"Resident mass mismatch in {tile['id']}")
        if sum(int(point["jobs"]) for point in demand["points"]) != pop_mass:
            raise ValueError(f"Job mass mismatch in {tile['id']}")
        native_mass += pop_mass
        native_points += len(point_ids)
        native_cohorts += len(pop_ids)

    cross = read_gzip_json(demand_root / "world" / "cross_demand.json.gz")
    commutes = read_json(demand_root / "world" / "cross_commutes.json")
    point_fields = {name: index for index, name in enumerate(cross["pointFields"])}
    pop_fields = {name: index for index, name in enumerate(cross["popFields"])}
    cross_ids = [str(row[pop_fields["id"]]) for row in cross["pops"]]
    if len(cross_ids) != len(set(cross_ids)):
        raise ValueError("Duplicate cross-demand IDs")
    residents = [0] * len(cross["points"])
    workers = [0] * len(cross["points"])
    cross_mass = 0
    cross_outside = 0
    valid_tile_ids = {tile["id"] for tile in selected}
    pref_for_tile = {tile["id"]: str(tile["prefCode"]) for tile in selected}
    for row in cross["pops"]:
        mass = int(row[pop_fields["mass"]])
        home = int(row[pop_fields["homePoint"]])
        work = int(row[pop_fields["workPoint"]])
        if not 0 <= home < len(cross["points"]) or not 0 <= work < len(cross["points"]):
            raise ValueError(f"Invalid cross endpoint in {row[pop_fields['id']]}")
        if mass <= 0 or int(row[pop_fields["drivingSeconds"]]) <= 0 or int(row[pop_fields["drivingDistance"]]) <= 0:
            raise ValueError(f"Invalid cross metrics in {row[pop_fields['id']]}")
        residents[home] += mass
        workers[work] += mass
        cross_mass += mass
    for index, row in enumerate(cross["points"]):
        point_tile = row[point_fields["tileId"]]
        if point_tile not in valid_tile_ids:
            raise ValueError(f"Unknown cross point tile: {point_tile}")
        if not boundaries[pref_for_tile[point_tile]].covers(Point(float(row[point_fields["longitude"]]), float(row[point_fields["latitude"]]))):
            cross_outside += 1
        if residents[index] != int(row[point_fields["residents"]]) or workers[index] != int(row[point_fields["workers"]]):
            raise ValueError(f"Cross point mass mismatch: {row[point_fields['id']]}")
    if cross_mass != sum(int(bucket["mass"]) for bucket in commutes["buckets"]):
        raise ValueError("Cross ledger and commute bucket mass differ")
    if outside:
        raise ValueError(f"{outside} native demand points are outside rendered boundaries")
    return {
        "valid": True,
        "tileCount": len(selected),
        "nativePointCount": native_points,
        "nativeCohortCount": native_cohorts,
        "nativeMass": native_mass,
        "crossPointCount": len(cross["points"]),
        "crossCohortCount": len(cross["pops"]),
        "crossMass": cross_mass,
        "crossOutsideRenderedBoundaryPointCount": cross_outside,
        "totalMass": native_mass + cross_mass,
        "outsideRenderedBoundary": outside,
    }


def main() -> None:
    repository_root = Path(__file__).resolve().parents[4]
    parser = argparse.ArgumentParser()
    parser.add_argument("--world-root", type=Path, default=repository_root / "worlds" / "japan")
    parser.add_argument("--demand-root", type=Path, default=repository_root / "prototype" / "japan" / "generated" / "demand")
    args = parser.parse_args()
    print(json.dumps(verify(args.world_root, args.demand_root), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
