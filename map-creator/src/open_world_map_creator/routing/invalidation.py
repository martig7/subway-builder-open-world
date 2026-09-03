"""Record demand endpoints whose driving routes must be recomputed later."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any


GRID_POINT_PREFIX = "deferred-source-"


def _read_gzip_json(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_grid_routing_invalidation(
    demand_dir: Path,
    *,
    point_prefix: str = GRID_POINT_PREFIX,
) -> dict[str, Any]:
    """Return an immutable invalidation set for visible census-grid endpoints.

    Existing route values are reusable only when a cohort is absent from this
    manifest and its identity, endpoint IDs, and mass still match the captured
    source artifact.
    """
    demand = demand_dir.resolve()
    native: dict[str, dict[str, Any]] = {}
    input_hashes: dict[str, str] = {}
    all_point_ids: set[str] = set()
    native_pop_count = 0

    for source_path in sorted((demand / "tiles").glob("*/demand_data.json.gz")):
        tile_id = source_path.parent.name
        payload = _read_gzip_json(source_path)
        marked_points = {
            str(point["id"]): point
            for point in payload["points"]
            if str(point["id"]).startswith(point_prefix)
        }
        if not marked_points:
            continue
        marked_pops = [
            pop
            for pop in payload["pops"]
            if str(pop["residenceId"]) in marked_points
            or str(pop["jobId"]) in marked_points
        ]
        native[tile_id] = {
            "points": [
                {
                    "id": point_id,
                    "location": list(marked_points[point_id]["location"]),
                }
                for point_id in sorted(marked_points)
            ],
            "pops": [
                {
                    "id": str(pop["id"]),
                    "residenceId": str(pop["residenceId"]),
                    "jobId": str(pop["jobId"]),
                    "size": int(pop["size"]),
                }
                for pop in sorted(marked_pops, key=lambda row: str(row["id"]))
            ],
        }
        all_point_ids.update(marked_points)
        native_pop_count += len(marked_pops)
        input_hashes[source_path.relative_to(demand).as_posix()] = _sha256(source_path)

    cross_path = demand / "world" / "cross_demand.json.gz"
    cross_payload = _read_gzip_json(cross_path)
    point_fields = {name: index for index, name in enumerate(cross_payload["pointFields"])}
    pop_fields = {name: index for index, name in enumerate(cross_payload["popFields"])}
    marked_point_indices = {
        index
        for index, point in enumerate(cross_payload["points"])
        if str(point[point_fields["id"]]).startswith(point_prefix)
    }
    marked_cross_points = []
    cross_point_ids: dict[int, str] = {}
    for index in sorted(marked_point_indices):
        point = cross_payload["points"][index]
        point_id = str(point[point_fields["id"]])
        cross_point_ids[index] = point_id
        all_point_ids.add(point_id)
        marked_cross_points.append({
            "id": point_id,
            "pointIndex": index,
            "longitude": float(point[point_fields["longitude"]]),
            "latitude": float(point[point_fields["latitude"]]),
            "tileId": str(point[point_fields["tileId"]]),
        })

    all_cross_point_ids = {
        index: str(point[point_fields["id"]])
        for index, point in enumerate(cross_payload["points"])
    }
    marked_cross_pops = []
    affected_partitions: set[tuple[str, str]] = set()
    for pop_index, pop in enumerate(cross_payload["pops"]):
        home_index = int(pop[pop_fields["homePoint"]])
        work_index = int(pop[pop_fields["workPoint"]])
        if home_index not in marked_point_indices and work_index not in marked_point_indices:
            continue
        home_point = cross_payload["points"][home_index]
        work_point = cross_payload["points"][work_index]
        home_tile = str(home_point[point_fields["tileId"]])
        work_tile = str(work_point[point_fields["tileId"]])
        affected_partitions.add((home_tile, work_tile))
        marked_cross_pops.append({
            "id": str(pop[pop_fields["id"]]),
            "popIndex": pop_index,
            "homePointId": all_cross_point_ids[home_index],
            "workPointId": all_cross_point_ids[work_index],
            "mass": int(pop[pop_fields["mass"]]),
            "partition": [home_tile, work_tile],
        })

    input_hashes[cross_path.relative_to(demand).as_posix()] = _sha256(cross_path)
    return {
        "schemaVersion": 1,
        "kind": "routing-invalidation",
        "reason": "raw census-grid demand endpoints require final-owner building anchors",
        "selection": {"pointIdPrefix": point_prefix},
        "routeReusePolicy": {
            "native": "reuse only if pop ID, residence ID, job ID, and mass still match; reroute every listed pop",
            "cross": "rebuild every listed directed tile-pair model and its derived cohort routes",
        },
        "inputHashes": dict(sorted(input_hashes.items())),
        "native": native,
        "cross": {
            "points": marked_cross_points,
            "pops": marked_cross_pops,
            "affectedPartitions": [list(pair) for pair in sorted(affected_partitions)],
        },
        "summary": {
            "uniquePointCount": len(all_point_ids),
            "nativeTileCount": len(native),
            "nativePointCount": sum(len(entry["points"]) for entry in native.values()),
            "nativePopCount": native_pop_count,
            "crossPointCount": len(marked_cross_points),
            "crossPopCount": len(marked_cross_pops),
            "crossPartitionCount": len(affected_partitions),
        },
    }


def write_grid_routing_invalidation(
    demand_dir: Path,
    output_path: Path,
) -> dict[str, Any]:
    demand = demand_dir.resolve()
    output = output_path.resolve()
    if output == demand or demand in output.parents:
        raise ValueError("Routing invalidation sidecar must be outside the live demand directory")
    manifest = build_grid_routing_invalidation(demand)
    output.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if output.suffix == ".gz":
        with output.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
                compressed.write(encoded)
    else:
        output.write_bytes(encoded)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demand-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = write_grid_routing_invalidation(args.demand_dir, args.output)
    print(json.dumps(manifest["summary"], sort_keys=True))


if __name__ == "__main__":
    main()
