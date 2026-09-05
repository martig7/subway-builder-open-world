from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
from typing import Any

import numpy as np
from pyproj import Transformer
import shapely
from shapely.geometry import Point, shape
from shapely.ops import transform
from shapely.strtree import STRtree
from open_world_map_creator.geography import computation_boundary


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as source:
        return json.load(source)


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type == "MultiPolygon":
        return list(geometry.geoms)
    return [part for part in geometry.geoms if part.geom_type == "Polygon"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--world-root",
        type=Path,
        default=REPOSITORY_ROOT / "worlds" / "japan",
    )
    parser.add_argument(
        "--demand-root",
        type=Path,
        default=REPOSITORY_ROOT / "prototype" / "japan" / "generated" / "demand",
    )
    parser.add_argument("--boundary-source", type=Path)
    parser.add_argument("--catalog-source", type=Path)
    parser.add_argument("--minimum-island-area-km2", type=float, default=1.0)
    parser.add_argument("--maximum-overlap-area-m2", type=float, default=1_000.0)
    parser.add_argument("--maximum-boundary-demand-amplification", type=float, default=1.5)
    parser.add_argument(
        "--source-home-mesh",
        type=Path,
        default=REPOSITORY_ROOT
        / "prototype"
        / "japan"
        / "generated"
        / "tokyo-kanagawa-test"
        / "home-mesh-250m.geojson",
    )
    args = parser.parse_args()

    catalog = read_json(
        args.catalog_source
        or args.world_root / "geography" / "tile-views.json"
    )
    boundary_source = read_json(
        args.boundary_source
        or computation_boundary(args.world_root)
    )
    tile_id_by_pref = {
        str(tile["prefCode"]): str(tile["id"])
        for tile in catalog["tiles"]
    }
    def feature_pref_code(feature: dict[str, Any]) -> str:
        properties = feature["properties"]
        if properties.get("pref_code") is not None:
            return str(properties["pref_code"])
        identifier = str(properties.get("id", ""))
        if identifier.startswith("JP") and identifier[2:].isdigit():
            return identifier[2:].zfill(2)
        raise ValueError(f"Boundary feature has no prefecture code: {properties}")

    geometries = {
        tile_id_by_pref[feature_pref_code(feature)]: shapely.make_valid(shape(feature["geometry"]))
        for feature in boundary_source["features"]
    }
    projected = Transformer.from_crs("EPSG:4326", catalog["crs"], always_xy=True)
    projected_geometries = {
        tile_id: shapely.make_valid(transform(projected.transform, geometry))
        for tile_id, geometry in geometries.items()
    }

    interior_ring_count = 0
    small_island_count = 0
    small_island_area_km2 = 0.0
    for geometry in projected_geometries.values():
        parts = polygon_parts(geometry)
        interior_ring_count += sum(len(part.interiors) for part in parts)
        small_parts = [
            part
            for part in parts
            if 1.0 < part.area < args.minimum_island_area_km2 * 1_000_000
        ]
        small_island_count += len(small_parts)
        small_island_area_km2 += sum(part.area for part in small_parts) / 1_000_000

    overlap_area_m2 = 0.0
    tile_ids = sorted(projected_geometries)
    for index, tile_id in enumerate(tile_ids):
        for other_tile_id in tile_ids[index + 1 :]:
            overlap_area_m2 += projected_geometries[tile_id].intersection(projected_geometries[other_tile_id]).area

    tile_by_id = {str(tile["id"]): tile for tile in catalog["tiles"]}
    code_by_tile_id = {
        str(tile["id"]): str(tile["prefCode"])
        for tile in catalog["tiles"]
    }
    land_seam_gaps = []
    visited_pairs: set[tuple[str, str]] = set()
    for tile_id, tile in tile_by_id.items():
        for neighbor in tile.get("neighbors", []):
            if neighbor.get("direction") != "land":
                continue
            pair = tuple(sorted((tile_id, str(neighbor["tileId"]))))
            if pair in visited_pairs:
                continue
            visited_pairs.add(pair)
            distance = projected_geometries[pair[0]].distance(projected_geometries[pair[1]])
            if distance > 0.01:
                land_seam_gaps.append({"tiles": pair, "distanceM": round(distance, 3)})

    coverage_reference = read_json(
        args.world_root / "sources" / "prefecture-boundaries.geojson"
    )
    reference_by_code = {
        str(feature["properties"]["id"])[2:].zfill(2): shape(feature["geometry"])
        for feature in coverage_reference["features"]
    }
    expected_land_pairs = {
        (left, right)
        for index, left in enumerate(sorted(reference_by_code))
        for right in sorted(reference_by_code)[index + 1 :]
        if reference_by_code[left].boundary.intersection(
            reference_by_code[right].boundary
        ).length
        > 1e-8
    }
    actual_land_pairs = {
        tuple(sorted((code_by_tile_id[tile_id], code_by_tile_id[str(neighbor["tileId"])])))
        for tile_id, tile in tile_by_id.items()
        for neighbor in tile.get("neighbors", [])
        if neighbor.get("direction") == "land"
    }
    missing_land_pairs = sorted(expected_land_pairs - actual_land_pairs)
    extra_land_pairs = sorted(actual_land_pairs - expected_land_pairs)

    native_outside_point_count = 0
    for tile_id, geometry in geometries.items():
        payload = read_gzip_json(args.demand_root / "tiles" / tile_id / "demand_data.json.gz")
        native_outside_point_count += sum(
            1
            for point in payload["points"]
            if not geometry.covers(Point(point["location"]))
        )

    boundary_list = [geometries[tile_id] for tile_id in tile_ids]
    boundary_tree = STRtree(boundary_list)
    boundary_id_by_index = {index: tile_id for index, tile_id in enumerate(tile_ids)}

    def owner(longitude: float, latitude: float) -> str | None:
        point = Point(longitude, latitude)
        owners = [
            boundary_id_by_index[int(index)]
            for index in boundary_tree.query(point)
            if boundary_list[int(index)].covers(point)
        ]
        return min(owners) if owners else None

    cross_demand = read_gzip_json(args.demand_root / "world" / "cross_demand.json.gz")
    point_fields = cross_demand["pointFields"]
    point_indexes = {field: index for index, field in enumerate(point_fields)}
    actual_owners = [
        owner(row[point_indexes["longitude"]], row[point_indexes["latitude"]])
        for row in cross_demand["points"]
    ]
    pop_fields = cross_demand["popFields"]
    pop_indexes = {field: index for index, field in enumerate(pop_fields)}
    cross_same_owner_cohort_count = 0
    cross_same_owner_mass = 0
    for row in cross_demand["pops"]:
        home_owner = actual_owners[row[pop_indexes["homePoint"]]]
        work_owner = actual_owners[row[pop_indexes["workPoint"]]]
        if home_owner is not None and home_owner == work_owner:
            cross_same_owner_cohort_count += 1
            cross_same_owner_mass += int(row[pop_indexes["mass"]])

    shared_boundary = projected_geometries["JP_TOKYO_MAINLAND"].boundary.intersection(
        projected_geometries["JP_KANAGAWA_MAINLAND"].boundary
    )

    def boundary_mass_fraction(rows: list[tuple[float, float, int]]) -> float:
        longitudes = np.asarray([row[0] for row in rows], dtype=np.float64)
        latitudes = np.asarray([row[1] for row in rows], dtype=np.float64)
        x_values, y_values = projected.transform(longitudes, latitudes)
        distances = shapely.distance(shapely.points(x_values, y_values), shared_boundary)
        masses = np.asarray([row[2] for row in rows], dtype=np.float64)
        return float(masses[distances <= 250].sum() / masses.sum())

    source_home = read_json(args.source_home_mesh)
    source_rows = [
        (
            float(feature["geometry"]["coordinates"][0]),
            float(feature["geometry"]["coordinates"][1]),
            int(feature["properties"]["commuters"]),
        )
        for feature in source_home["features"]
        if str(feature["properties"].get("prefCode")) == "13"
        and geometries["JP_TOKYO_MAINLAND"].covers(shape(feature["geometry"]))
    ]
    emitted_rows = []
    tokyo_native = read_gzip_json(
        args.demand_root / "tiles" / "JP_TOKYO_MAINLAND" / "demand_data.json.gz"
    )
    emitted_rows.extend(
        (float(point["location"][0]), float(point["location"][1]), int(point["residents"]))
        for point in tokyo_native["points"]
        if int(point.get("residents", 0)) > 0
    )
    emitted_rows.extend(
        (
            float(row[point_indexes["longitude"]]),
            float(row[point_indexes["latitude"]]),
            int(row[point_indexes["residents"]]),
        )
        for row in cross_demand["points"]
        if row[point_indexes["tileId"]] == "JP_TOKYO_MAINLAND"
        and int(row[point_indexes["residents"]]) > 0
    )
    source_boundary_mass_fraction = boundary_mass_fraction(source_rows)
    emitted_boundary_mass_fraction = boundary_mass_fraction(emitted_rows)
    boundary_demand_amplification = (
        emitted_boundary_mass_fraction / source_boundary_mass_fraction
    )

    report = {
        "interiorRingCount": interior_ring_count,
        "landSeamGapCount": len(land_seam_gaps),
        "landSeamGaps": land_seam_gaps,
        "missingLandAdjacencyPairs": missing_land_pairs,
        "extraLandAdjacencyPairs": extra_land_pairs,
        "nativeOutsidePointCount": native_outside_point_count,
        "overlapAreaM2": round(overlap_area_m2, 6),
        "smallIslandAreaKm2": round(small_island_area_km2, 6),
        "smallIslandCount": small_island_count,
        "crossSameOwnerCohortCount": cross_same_owner_cohort_count,
        "crossSameOwnerMass": cross_same_owner_mass,
        "tokyoSourceMassWithin250mFraction": round(source_boundary_mass_fraction, 8),
        "tokyoEmittedMassWithin250mFraction": round(emitted_boundary_mass_fraction, 8),
        "tokyoBoundaryDemandAmplification": round(boundary_demand_amplification, 6),
        "tokyoKanagawaSharedBoundaryCoordinateCount": int(
            shapely.get_num_coordinates(shared_boundary)
        ),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    failures = [
        interior_ring_count > 0,
        small_island_count > 0,
        bool(land_seam_gaps),
        overlap_area_m2 > args.maximum_overlap_area_m2,
        native_outside_point_count > 0,
        cross_same_owner_cohort_count > 0,
        boundary_demand_amplification > args.maximum_boundary_demand_amplification,
    ]
    return 1 if any(failures) else 0


if __name__ == "__main__":
    raise SystemExit(main())
