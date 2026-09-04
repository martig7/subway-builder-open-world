"""Relocate marked census-grid demand endpoints onto real building centers."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import shape

from open_world_map_creator.demand.building_sites import read_building_centers

from .generated_roads import (
    _driving_model,
    _gzip_json,
    _read_gzip_json,
    _refresh_enriched_tile_manifest,
    _write_json,
)


def _read_json_or_gzip(path: Path) -> dict[str, Any]:
    if path.suffix == ".gz":
        with gzip.open(path, "rt", encoding="utf-8") as source:
            return json.load(source)
    return json.loads(path.read_text(encoding="utf-8"))


def _marked_points(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    marked: dict[str, dict[str, Any]] = {}
    for tile_id, entry in manifest["native"].items():
        for point in entry["points"]:
            marked[str(point["id"])] = {
                "tileId": tile_id,
                "location": tuple(map(float, point["location"])),
            }
    for point in manifest["cross"]["points"]:
        point_id = str(point["id"])
        candidate = {
            "tileId": str(point["tileId"]),
            "location": (float(point["longitude"]), float(point["latitude"])),
        }
        previous = marked.setdefault(point_id, candidate)
        if previous != candidate:
            raise ValueError(f"Inconsistent invalidation entries for {point_id}")
    return marked


def _nearest_unique_buildings(
    point_rows: list[tuple[str, tuple[float, float]]],
    building_index: Path,
    bounds: list[float],
    *,
    maximum_snap_metres: float,
    reserved_locations: set[tuple[float, float]] | None = None,
    allowed_boundary: Any | None = None,
) -> tuple[dict[str, tuple[float, float]], list[float], dict[str, float]]:
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    buildings = read_building_centers(building_index, bounds, transformer)
    if allowed_boundary is not None:
        inside = np.asarray(
            shapely.contains_xy(
                allowed_boundary,
                buildings["longitudes"],
                buildings["latitudes"],
            ),
            dtype=bool,
        )
        buildings = {
            key: value[inside] if isinstance(value, np.ndarray) else value
            for key, value in buildings.items()
        }
    if not len(buildings["x"]):
        raise ValueError(f"No buildings available in {building_index}")
    tree = cKDTree(np.column_stack((buildings["x"], buildings["y"])))
    longitudes = np.asarray([row[1][0] for row in point_rows], dtype=np.float64)
    latitudes = np.asarray([row[1][1] for row in point_rows], dtype=np.float64)
    x_values, y_values = transformer.transform(longitudes, latitudes)
    candidate_count = min(128, len(buildings["x"]))
    distances, candidates = tree.query(
        np.column_stack((x_values, y_values)),
        k=candidate_count,
        workers=-1,
    )
    if candidate_count == 1:
        distances = np.asarray(distances).reshape(-1, 1)
        candidates = np.asarray(candidates).reshape(-1, 1)

    result: dict[str, tuple[float, float]] = {}
    snaps: list[float] = []
    skipped: dict[str, float] = {}
    used_locations = set(reserved_locations or ())
    point_order = sorted(range(len(point_rows)), key=lambda index: point_rows[index][0])
    for point_index in point_order:
        choices = [
            (float(distance), int(building_index_value))
            for distance, building_index_value in zip(
                distances[point_index], candidates[point_index], strict=True
            )
        ]
        def building_location(building_index_value: int) -> tuple[float, float]:
            return (
                round(float(buildings["longitudes"][building_index_value]), 7),
                round(float(buildings["latitudes"][building_index_value]), 7),
            )

        selection = next(
            (
                choice
                for choice in choices
                if building_location(choice[1]) not in used_locations
            ),
            None,
        )
        if selection is None:
            skipped[point_rows[point_index][0]] = float(choices[0][0])
            continue
        distance, selected = selection
        if distance > maximum_snap_metres:
            skipped[point_rows[point_index][0]] = distance
            continue
        location = building_location(selected)
        used_locations.add(location)
        result[point_rows[point_index][0]] = location
        snaps.append(distance)
    return result, snaps, skipped


def _filter_invalidation(
    manifest: dict[str, Any], moved_ids: set[str]
) -> dict[str, Any]:
    filtered = {**manifest}
    native: dict[str, dict[str, Any]] = {}
    for tile_id, entry in manifest["native"].items():
        points = [point for point in entry["points"] if str(point["id"]) in moved_ids]
        pops = [
            pop
            for pop in entry["pops"]
            if str(pop["residenceId"]) in moved_ids or str(pop["jobId"]) in moved_ids
        ]
        if points or pops:
            native[tile_id] = {"points": points, "pops": pops}
    cross_points = [
        point for point in manifest["cross"]["points"] if str(point["id"]) in moved_ids
    ]
    cross_pops = [
        pop
        for pop in manifest["cross"]["pops"]
        if str(pop["homePointId"]) in moved_ids or str(pop["workPointId"]) in moved_ids
    ]
    partitions = sorted({tuple(map(str, pop["partition"])) for pop in cross_pops})
    filtered["native"] = native
    filtered["cross"] = {
        "points": cross_points,
        "pops": cross_pops,
        "affectedPartitions": [list(partition) for partition in partitions],
    }
    filtered["summary"] = {
        "uniquePointCount": len(moved_ids),
        "nativeTileCount": len(native),
        "nativePointCount": sum(len(entry["points"]) for entry in native.values()),
        "nativePopCount": sum(len(entry["pops"]) for entry in native.values()),
        "crossPointCount": len(cross_points),
        "crossPopCount": len(cross_pops),
        "crossPartitionCount": len(partitions),
    }
    return filtered


def relocate_marked_grid_points(
    demand_dir: Path,
    output_dir: Path,
    catalog_path: Path,
    maps_dir: Path,
    invalidation_path: Path,
    *,
    maximum_snap_metres: float = 5_000.0,
    boundary_path: Path | None = None,
) -> dict[str, Any]:
    """Copy a routed demand package and move only invalidated endpoint coordinates."""
    source = demand_dir.resolve()
    output = output_dir.resolve()
    if output.exists():
        raise FileExistsError(f"Repair output already exists: {output}")
    if output == source or source in output.parents:
        raise ValueError("Repair output must be outside the source demand directory")

    manifest = _read_json_or_gzip(invalidation_path)
    marked = _marked_points(manifest)
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    tiles = {str(tile["id"]): tile for tile in catalog["tiles"]}
    boundary_source = json.loads(
        (boundary_path or catalog_path.parent / "prefectures.geojson").read_text(
            encoding="utf-8"
        )
    )
    boundaries = {
        str(feature["properties"]["pref_code"]): shape(feature["geometry"])
        for feature in boundary_source["features"]
    }
    native_ids = {
        str(point["id"])
        for entry in manifest["native"].values()
        for point in entry["points"]
    }
    points_by_tile: dict[str, list[tuple[str, tuple[float, float]]]] = defaultdict(list)
    for point_id, entry in marked.items():
        points_by_tile[str(entry["tileId"])].append((point_id, entry["location"]))

    replacements: dict[str, tuple[float, float]] = {}
    snaps: list[float] = []
    skipped: dict[str, float] = {}
    reserved_locations: set[tuple[float, float]] = set()
    for tile_id, rows in sorted(points_by_tile.items()):
        tile = tiles.get(tile_id)
        if tile is None:
            raise ValueError(f"Invalidation references unknown tile {tile_id}")
        native_rows = [row for row in rows if row[0] in native_ids]
        cross_only_rows = [row for row in rows if row[0] not in native_ids]
        for selected_rows, allowed_boundary in (
            (native_rows, boundaries[str(tile["prefCode"])]),
            (cross_only_rows, None),
        ):
            if not selected_rows:
                continue
            tile_replacements, tile_snaps, tile_skipped = _nearest_unique_buildings(
                selected_rows,
                maps_dir / tile_id / "buildings_index.bin.gz",
                [float(value) for value in tile["bounds"]],
                maximum_snap_metres=maximum_snap_metres,
                reserved_locations=reserved_locations,
                allowed_boundary=allowed_boundary,
            )
            replacements.update(tile_replacements)
            reserved_locations.update(tile_replacements.values())
            snaps.extend(tile_snaps)
            skipped.update(tile_skipped)

    shutil.copytree(source, output)
    moved_native_occurrences = 0
    moved_ids: set[str] = set()
    for tile_id, entry in manifest["native"].items():
        path = output / "tiles" / tile_id / "demand_data.json.gz"
        payload = _read_gzip_json(path)
        points = {str(point["id"]): point for point in payload["points"]}
        for captured in entry["points"]:
            point_id = str(captured["id"])
            if point_id not in replacements:
                continue
            point = points.get(point_id)
            if point is None:
                raise ValueError(f"Missing invalidated native point {tile_id}:{point_id}")
            current = tuple(map(float, point["location"]))
            expected = tuple(map(float, captured["location"]))
            if current != expected:
                raise ValueError(
                    f"Native point moved before repair {tile_id}:{point_id}: {current} != {expected}"
                )
            point["location"] = list(replacements[point_id])
            moved_native_occurrences += 1
            moved_ids.add(point_id)
        _gzip_json(path, payload)

    cross_path = output / "world" / "cross_demand.json.gz"
    cross = _read_gzip_json(cross_path)
    point_fields = {name: index for index, name in enumerate(cross["pointFields"])}
    cross_by_id = {
        str(point[point_fields["id"]]): point for point in cross["points"]
    }
    moved_cross_occurrences = 0
    for captured in manifest["cross"]["points"]:
        point_id = str(captured["id"])
        if point_id not in replacements:
            continue
        point = cross_by_id.get(point_id)
        if point is None:
            raise ValueError(f"Missing invalidated cross point {point_id}")
        current = (
            float(point[point_fields["longitude"]]),
            float(point[point_fields["latitude"]]),
        )
        expected = (float(captured["longitude"]), float(captured["latitude"]))
        if current != expected:
            raise ValueError(f"Cross point moved before repair {point_id}: {current} != {expected}")
        replacement = replacements[point_id]
        point[point_fields["longitude"]] = replacement[0]
        point[point_fields["latitude"]] = replacement[1]
        moved_cross_occurrences += 1
        moved_ids.add(point_id)
    cross["drivingModel"] = {
        **_driving_model(),
        "status": "selected-endpoints-require-rerouting",
    }
    _gzip_json(cross_path, cross)

    commutes = json.loads((output / "world" / "cross_commutes.json").read_text(encoding="utf-8"))
    for tile_id in tiles:
        tile_root = output / "tiles" / tile_id
        _gzip_json(tile_root / "cross_demand.json.gz", {**cross, "tileId": tile_id})
        _write_json(tile_root / "cross_commutes.json", {**commutes, "tileId": tile_id})
        tile_manifest = json.loads((tile_root / "manifest.json").read_text(encoding="utf-8"))
        _write_json(
            tile_root / "manifest.json",
            _refresh_enriched_tile_manifest(tile_manifest, tile_root),
        )

    report = {
        "schemaVersion": 1,
        "kind": "grid-demand building relocation",
        "status": "routing-required",
        "invalidation": str(invalidation_path.resolve()),
        "uniquePointCount": len(moved_ids),
        "skippedPointCount": len(skipped),
        "maximumSkippedSnapMetres": round(max(skipped.values(), default=0.0), 3),
        "nativePointOccurrenceCount": moved_native_occurrences,
        "crossPointOccurrenceCount": moved_cross_occurrences,
        "maximumSnapMetres": round(max(snaps, default=0.0), 3),
        "meanSnapMetres": round(sum(snaps) / max(1, len(snaps)), 3),
        "duplicateBuildingAssignments": len(replacements) - len(set(replacements.values())),
    }
    filtered_invalidation = _filter_invalidation(manifest, moved_ids)
    _write_json(
        output / "reports" / "japan-national-grid-repair-routing-invalidation.json",
        filtered_invalidation,
    )
    _write_json(output / "reports" / "japan-national-grid-repair.json", report)
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demand-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--maps-dir", type=Path, required=True)
    parser.add_argument("--invalidation", type=Path, required=True)
    parser.add_argument("--maximum-snap-metres", type=float, default=5_000.0)
    parser.add_argument("--boundaries", type=Path)
    args = parser.parse_args(argv)
    report = relocate_marked_grid_points(
        args.demand_dir,
        args.output_dir,
        args.catalog,
        args.maps_dir,
        args.invalidation,
        maximum_snap_metres=args.maximum_snap_metres,
        boundary_path=args.boundaries,
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
