"""Build irregular, land-anchored demand sites from census cells and OSM buildings."""

from __future__ import annotations

import gzip
import hashlib
import math
import struct
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import shapely
from pyproj import Transformer
from scipy.spatial import cKDTree


BINARY_MAGIC = 1_229_079_123
BINARY_VERSION = 1
HEADER_SIZE = 88


def _local_metric_crs(boundary: Any) -> str:
    center = boundary.representative_point()
    return (
        f"+proj=aeqd +lat_0={center.y:.10f} +lon_0={center.x:.10f} "
        "+datum=WGS84 +units=m +no_defs"
    )


def _stable_priority(value: str) -> int:
    return int.from_bytes(hashlib.blake2b(value.encode("utf-8"), digest_size=8).digest(), "big")


def _read_exact(source: Any, byte_count: int) -> bytes:
    chunks: list[bytes] = []
    remaining = byte_count
    while remaining:
        chunk = source.read(remaining)
        if not chunk:
            raise EOFError(f"Building index ended {remaining:,} bytes before its bounds section was complete")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_building_centers(
    path: Path,
    clip_bounds: list[float],
    transformer: Transformer,
) -> dict[str, Any]:
    """Read only the header/bounds prefix of Depot's binary building index."""
    with gzip.open(path, "rb") as source:
        header = _read_exact(source, HEADER_SIZE)
        magic = struct.unpack_from("<I", header, 0)[0]
        version = header[4]
        building_count = struct.unpack_from("<I", header, 8)[0]
        cell_size_degrees = struct.unpack_from("<d", header, 40)[0]
        if magic != BINARY_MAGIC:
            raise ValueError(f"{path} is not a supported building index (magic={magic:#x})")
        if version != BINARY_VERSION:
            raise ValueError(f"{path} uses unsupported building-index version {version}")
        raw_bounds = _read_exact(source, building_count * 4 * 8)

    building_bounds = np.frombuffer(raw_bounds, dtype="<f8").reshape(building_count, 4)
    longitudes = (building_bounds[:, 0] + building_bounds[:, 2]) / 2
    latitudes = (building_bounds[:, 1] + building_bounds[:, 3]) / 2
    min_lon, min_lat, max_lon, max_lat = clip_bounds
    selected = (
        np.isfinite(longitudes)
        & np.isfinite(latitudes)
        & (building_bounds[:, 2] > building_bounds[:, 0])
        & (building_bounds[:, 3] > building_bounds[:, 1])
        & (longitudes >= min_lon)
        & (longitudes <= max_lon)
        & (latitudes >= min_lat)
        & (latitudes <= max_lat)
    )
    source_ids = np.flatnonzero(selected).astype(np.int64, copy=False)
    longitudes = longitudes[selected].copy()
    latitudes = latitudes[selected].copy()
    x_values, y_values = transformer.transform(longitudes, latitudes)
    return {
        "sourceIds": source_ids,
        "longitudes": longitudes,
        "latitudes": latitudes,
        "x": np.asarray(x_values, dtype=np.float64),
        "y": np.asarray(y_values, dtype=np.float64),
        "cellSizeDegrees": cell_size_degrees,
    }


def select_building_candidates(
    tile_id: str,
    home_cells: list[dict[str, Any]],
    job_cells: list[dict[str, Any]],
    buildings: dict[str, Any],
    transformer: Transformer,
    boundary: Any,
    *,
    source_radius_m: float = 750.0,
    candidate_grid_m: float = 100.0,
    chunk_size: int = 250_000,
    physical_land: Any | None = None,
    maximum_assignment_m: float | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Choose irregular building anchors independently of the e-Stat lattice."""
    source_cells = [*home_cells, *job_cells]
    if not source_cells:
        return [], {}
    if len(buildings["x"]) == 0:
        raise ValueError(f"{tile_id} has no building centers inside its native bounds")
    if source_radius_m <= 0 or candidate_grid_m <= 0:
        raise ValueError("Building-source radius and candidate grid must be positive")

    source_longitudes = np.asarray([cell["longitude"] for cell in source_cells], dtype=np.float64)
    source_latitudes = np.asarray([cell["latitude"] for cell in source_cells], dtype=np.float64)
    source_x, source_y = transformer.transform(source_longitudes, source_latitudes)
    source_tree = cKDTree(np.column_stack((source_x, source_y)))
    if maximum_assignment_m is not None and maximum_assignment_m <= 0:
        raise ValueError('Maximum assignment distance must be positive')
    search_radius = max(source_radius_m, maximum_assignment_m or source_radius_m)
    retained_parts: list[np.ndarray] = []
    for start in range(0, len(buildings["x"]), chunk_size):
        end = min(start + chunk_size, len(buildings["x"]))
        distances, _ = source_tree.query(
            np.column_stack((buildings["x"][start:end], buildings["y"][start:end])),
            k=1,
            workers=-1,
        )
        retained_parts.append(np.flatnonzero(distances <= search_radius) + start)
    retained = np.concatenate(retained_parts)
    inside = shapely.covers(
        boundary,
        # Ownership must still hold after the serialized coordinate rounding.
        shapely.points(np.round(buildings["longitudes"][retained], 7), np.round(buildings["latitudes"][retained], 7)),
    )
    retained = retained[np.asarray(inside, dtype=bool)]
    off_land_count = 0
    if physical_land is not None:
        on_land = physical_land.covers(np.column_stack((np.round(buildings['longitudes'][retained],7),
                                                       np.round(buildings['latitudes'][retained],7))))
        off_land_count = int((~on_land).sum())
        retained = retained[on_land]
    if len(retained) == 0:
        raise ValueError(f"{tile_id} has no in-boundary buildings near positive demand sources")

    nearest_fill_count = 0
    if maximum_assignment_m is not None:
        coordinates = np.column_stack((buildings['x'][retained], buildings['y'][retained]))
        near_distances, _ = source_tree.query(coordinates, workers=-1)
        near = retained[near_distances <= source_radius_m]
        building_tree = cKDTree(coordinates)
        distances, indexes = building_tree.query(np.column_stack((source_x,source_y)), workers=-1)
        # The broad search only contributes each cell's nearest real building;
        # it does not emit a mesh-centred or off-land fallback. Final clustering
        # and the caller's assignment cap still apply to every resulting point.
        nearest = retained[indexes[distances <= maximum_assignment_m]]
        retained = np.union1d(near, nearest)
        nearest_fill_count = len(retained) - len(near)

    grid_x = np.floor(buildings["x"][retained] / candidate_grid_m).astype(np.int64)
    grid_y = np.floor(buildings["y"][retained] / candidate_grid_m).astype(np.int64)
    grid_y_span = int(grid_y.max() - grid_y.min() + 1)
    grid_key = (grid_x - grid_x.min()) * grid_y_span + (grid_y - grid_y.min())
    order = np.lexsort((buildings["sourceIds"][retained], grid_key))
    ordered_keys = grid_key[order]
    first_in_cell = np.r_[True, ordered_keys[1:] != ordered_keys[:-1]]
    selected_indices = retained[order[first_in_cell]]

    seeds = []
    for building_index in selected_indices:
        source_id = int(buildings["sourceIds"][building_index])
        seeds.append({
            "id": buildings.get("supplementalIds", {}).get(source_id, f"osm-building-{tile_id.lower()}-{source_id}"),
            "x": float(buildings["x"][building_index]),
            "y": float(buildings["y"][building_index]),
            "longitude": float(buildings["longitudes"][building_index]),
            "latitude": float(buildings["latitudes"][building_index]),
            "weight": 1,
        })
    return seeds, {
        "buildingCount": len(buildings["x"]),
        "rejectedOffLandBuildingCount": off_land_count,
        "nearestBuildingCoverageFillCount": nearest_fill_count,
        "buildingIndexCellDegrees": buildings["cellSizeDegrees"],
        "homeSourceCellCount": len(home_cells),
        "jobSourceCellCount": len(job_cells),
        "nearSourceBuildingCount": len(retained),
        "fineSeedCount": len(seeds),
        "buildingSourceRadiusM": source_radius_m,
        "candidateGridM": candidate_grid_m,
    }


def assign_source_weights(
    sites: list[dict[str, Any]],
    cells: list[dict[str, Any]],
    value_field: str,
    transformer: Transformer,
) -> tuple[list[int], float]:
    if not cells:
        return [0] * len(sites), 0.0
    site_coordinates = np.asarray([(site["x"], site["y"]) for site in sites], dtype=np.float64)
    longitudes = np.asarray([cell["longitude"] for cell in cells], dtype=np.float64)
    latitudes = np.asarray([cell["latitude"] for cell in cells], dtype=np.float64)
    x_values, y_values = transformer.transform(longitudes, latitudes)
    distances, nearest = cKDTree(site_coordinates).query(
        np.column_stack((x_values, y_values)), k=1, workers=-1
    )
    weights = np.bincount(
        np.asarray(nearest, dtype=np.int64),
        weights=np.asarray([int(cell[value_field]) for cell in cells], dtype=np.int64),
        minlength=len(sites),
    ).astype(np.int64)
    return weights.tolist(), float(np.max(distances, initial=0.0))


def cluster_building_seeds(
    tile_id: str,
    fine_seeds: list[dict[str, Any]],
    radius_m: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Apply NEC's maximal-radius Voronoi merge and snap to a member building."""
    if radius_m <= 0:
        raise ValueError("Voronoi seed radius must be positive")
    if not fine_seeds:
        return [], {}

    radius_squared = radius_m * radius_m
    seed_grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    selected_seeds: list[dict[str, Any]] = []
    for candidate in sorted(fine_seeds, key=lambda row: (_stable_priority(row["id"]), row["id"])):
        gx, gy = math.floor(candidate["x"] / radius_m), math.floor(candidate["y"] / radius_m)
        blocked = any(
            (candidate["x"] - selected_seeds[index]["x"]) ** 2
            + (candidate["y"] - selected_seeds[index]["y"]) ** 2
            <= radius_squared
            for dx in (-1, 0, 1)
            for dy in (-1, 0, 1)
            for index in seed_grid.get((gx + dx, gy + dy), ())
        )
        if not blocked:
            index = len(selected_seeds)
            selected_seeds.append(candidate)
            seed_grid[(gx, gy)].append(index)

    members: list[list[dict[str, Any]]] = [[] for _ in selected_seeds]
    for fine_seed in fine_seeds:
        gx, gy = math.floor(fine_seed["x"] / radius_m), math.floor(fine_seed["y"] / radius_m)
        candidates = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for index in seed_grid.get((gx + dx, gy + dy), ()):
                    seed = selected_seeds[index]
                    distance_squared = (fine_seed["x"] - seed["x"]) ** 2 + (fine_seed["y"] - seed["y"]) ** 2
                    if distance_squared <= radius_squared:
                        candidates.append((distance_squared, _stable_priority(seed["id"]), index))
        if not candidates:
            raise AssertionError(f"{tile_id} maximal Voronoi seed set failed to cover {fine_seed['id']}")
        members[min(candidates)[2]].append(fine_seed)

    sites = []
    maximum_snap_distance = 0.0
    for grouped in members:
        if not grouped:
            continue
        total = sum(member["weight"] for member in grouped)
        centroid_x = sum(member["x"] * member["weight"] for member in grouped) / total
        centroid_y = sum(member["y"] * member["weight"] for member in grouped) / total
        anchor = min(
            grouped,
            key=lambda member: (
                (member["x"] - centroid_x) ** 2 + (member["y"] - centroid_y) ** 2,
                _stable_priority(member["id"]),
            ),
        )
        snap_distance = math.dist((centroid_x, centroid_y), (anchor["x"], anchor["y"]))
        maximum_snap_distance = max(maximum_snap_distance, snap_distance)
        digest = hashlib.sha256()
        for member_id in sorted(member["id"] for member in grouped):
            digest.update(member_id.encode("utf-8"))
            digest.update(b"\0")
        sites.append({
            "id": f"demand-site-{digest.hexdigest()[:24]}",
            "location": [round(anchor["longitude"], 7), round(anchor["latitude"], 7)],
            "x": anchor["x"],
            "y": anchor["y"],
            "weight": total,
            "commuters": total,
            "fineSeedCount": len(grouped),
        })
    sites.sort(key=lambda site: site["id"])
    if sum(site["commuters"] for site in sites) != sum(seed["weight"] for seed in fine_seeds):
        raise AssertionError(f"{tile_id} Voronoi sites did not conserve fine-seed mass")
    return sites, {
        "siteCount": len(sites),
        "maximumSiteSnapDistanceM": round(maximum_snap_distance, 3),
        "unanchoredSiteCount": 0,
    }


def build_tile_sites(
    tile_id: str,
    home_cells: list[dict[str, Any]],
    job_cells: list[dict[str, Any]],
    building_index_path: Path,
    clip_bounds: list[float],
    boundary: Any,
    *,
    candidate_boundary: Any | None = None,
    radius_m: float = 350.0,
    source_radius_m: float = 750.0,
    candidate_grid_m: float = 100.0,
    supplemental_buildings: list[dict[str, Any]] | None = None,
    physical_land: Any | None = None,
    maximum_assignment_m: float | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    transformer = Transformer.from_crs("EPSG:4326", _local_metric_crs(boundary), always_xy=True)
    shapely.prepare(boundary)
    if candidate_boundary is not None:
        shapely.prepare(candidate_boundary)
    buildings = read_building_centers(building_index_path, clip_bounds, transformer)
    supplements = sorted(supplemental_buildings or [], key=lambda row: row['id'])
    if len({row['id'] for row in supplements}) != len(supplements):
        raise ValueError('Duplicate supplemental building IDs')
    if supplements:
        coordinates = np.asarray([row['location'] for row in supplements], dtype=float)
        if coordinates.shape != (len(supplements), 2) or not np.isfinite(coordinates).all():
            raise ValueError('Invalid supplemental building coordinates')
        longitudes, latitudes = coordinates.T
        x, y = transformer.transform(longitudes, latitudes)
        for key, values in [('longitudes', longitudes), ('latitudes', latitudes), ('x', x), ('y', y),
                            ('sourceIds', -np.arange(1, len(supplements)+1))]:
            buildings[key] = np.concatenate((buildings[key], values))
        buildings['supplementalIds'] = {-i-1: row['id'] for i, row in enumerate(supplements)}
    fine_seeds, fine_report = select_building_candidates(
        tile_id,
        home_cells,
        job_cells,
        buildings,
        transformer,
        candidate_boundary if candidate_boundary is not None else boundary,
        source_radius_m=source_radius_m,
        candidate_grid_m=candidate_grid_m,
        physical_land=physical_land,
        maximum_assignment_m=maximum_assignment_m,
    )
    sites, merge_report = cluster_building_seeds(tile_id, fine_seeds, radius_m)
    home_weights, maximum_home_distance = assign_source_weights(
        sites, home_cells, "commuters", transformer
    )
    job_weights, maximum_job_distance = assign_source_weights(
        sites, job_cells, "jobs", transformer
    )
    populated_sites = []
    for site, home_weight, job_weight in zip(sites, home_weights, job_weights, strict=True):
        if home_weight <= 0 and job_weight <= 0:
            continue
        populated_sites.append({
            **{key: value for key, value in site.items() if key not in {"x", "y"}},
            "weight": home_weight + job_weight,
            "commuters": home_weight,
            "jobs": job_weight,
        })
    return populated_sites, {
        **fine_report,
        **merge_report,
        "supplementalBuildingCount": len(supplements),
        "siteCount": len(populated_sites),
        "mergeRadiusM": radius_m,
        "maximumHomeCellToSiteDistanceM": round(maximum_home_distance, 3),
        "maximumJobCellToSiteDistanceM": round(maximum_job_distance, 3),
        "inputHomeMass": sum(int(cell["commuters"]) for cell in home_cells),
        "inputJobMass": sum(int(cell["jobs"]) for cell in job_cells),
    }
