from __future__ import annotations

import hashlib
import math
import sqlite3
from collections import defaultdict
from typing import Any, Callable

import numpy as np
from scipy.spatial import cKDTree


MASK_64 = (1 << 64) - 1


def _stable_id(*parts: object) -> str:
    payload = "\x1f".join(map(str, parts)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:24]


def _stable_priority(value: str) -> int:
    return int.from_bytes(hashlib.blake2b(value.encode("utf-8"), digest_size=8).digest(), "big")


def _site_bits(site_id: str) -> int:
    tail = site_id.rsplit("-", 1)[-1][-16:]
    try:
        return int(tail, 16)
    except ValueError:
        return _stable_priority(site_id)


def _mix_64(value: int) -> int:
    value = (value + 0x9E3779B97F4A7C15) & MASK_64
    value = ((value ^ (value >> 30)) * 0xBF58476D1CE4E5B9) & MASK_64
    value = ((value ^ (value >> 27)) * 0x94D049BB133111EB) & MASK_64
    return value ^ (value >> 31)


def _pair_priority(home_site: str, work_site: str) -> int:
    home = _site_bits(home_site)
    work = _site_bits(work_site)
    return _mix_64(home ^ ((work << 29) | (work >> 35)))


def cluster_demand_sites(
    tile_id: str,
    locations: list[tuple[str, float, float, int]],
    radius: float,
) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    if radius <= 0:
        raise ValueError("Voronoi seed radius must be positive")
    if not locations:
        return {}, {}
    if any(weight <= 0 for _, _, _, weight in locations):
        raise ValueError("Voronoi source weights must be positive")

    radius_squared = radius * radius
    seed_grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    seeds: list[dict[str, Any]] = []
    ordered = sorted(locations, key=lambda row: (_stable_priority(row[0]), row[0]))
    for block_id, x, y, _ in ordered:
        gx, gy = math.floor(x / radius), math.floor(y / radius)
        blocked = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for seed_index in seed_grid.get((gx + dx, gy + dy), ()):
                    seed = seeds[seed_index]
                    if (x - seed["x"]) ** 2 + (y - seed["y"]) ** 2 <= radius_squared:
                        blocked = True
                        break
                if blocked:
                    break
            if blocked:
                break
        if not blocked:
            seed_index = len(seeds)
            seeds.append({"blockId": block_id, "x": x, "y": y})
            seed_grid[(gx, gy)].append(seed_index)

    sum_x = [0.0] * len(seeds)
    sum_y = [0.0] * len(seeds)
    weights = [0] * len(seeds)
    members: list[list[str]] = [[] for _ in seeds]
    for block_id, x, y, weight in locations:
        gx, gy = math.floor(x / radius), math.floor(y / radius)
        candidates: list[tuple[float, int, int]] = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for seed_index in seed_grid.get((gx + dx, gy + dy), ()):
                    seed = seeds[seed_index]
                    distance_squared = (x - seed["x"]) ** 2 + (y - seed["y"]) ** 2
                    if distance_squared <= radius_squared:
                        candidates.append((distance_squared, _stable_priority(seed["blockId"]), seed_index))
        if not candidates:
            raise AssertionError(f"Maximal Voronoi seed set failed to cover {block_id}")
        seed_index = min(candidates)[2]
        sum_x[seed_index] += x * weight
        sum_y[seed_index] += y * weight
        weights[seed_index] += weight
        members[seed_index].append(block_id)

    assignment: dict[str, str] = {}
    sites: dict[str, dict[str, Any]] = {}
    populated = [index for index, weight in enumerate(weights) if weight > 0]
    populated.sort(key=lambda index: seeds[index]["blockId"])
    for index in populated:
        cell_members = sorted(members[index])
        site_id = f"demand-site-{_stable_id('nec-voronoi-v1', tile_id, *cell_members)}"
        sites[site_id] = {
            "id": site_id,
            "tileId": tile_id,
            "x": sum_x[index] / weights[index],
            "y": sum_y[index] / weights[index],
        }
        for block_id in cell_members:
            assignment[block_id] = site_id
    return assignment, sites


def _merge_undersized_cells(cells: list[dict[str, Any]], minimum_size: int, maximum_size: int) -> None:
    while True:
        active = [index for index, cell in enumerate(cells) if cell["active"]]
        undersized = [index for index in active if cells[index]["mass"] < minimum_size]
        if not undersized:
            return
        if len(active) == 1:
            raise ValueError(f"Total flow mass {cells[active[0]]['mass']} is below minimum cohort size {minimum_size}")

        active_positions = np.asarray([cells[index]["position"] for index in active], dtype=np.float64)
        tree = cKDTree(active_positions)
        neighbor_count = min(32, len(active))
        _, neighbor_rows = tree.query(
            np.asarray([cells[index]["position"] for index in undersized], dtype=np.float64),
            k=neighbor_count,
            workers=-1,
        )
        if neighbor_count == 1:
            neighbor_rows = np.asarray(neighbor_rows).reshape(-1, 1)

        merged_this_round = 0
        ordered = sorted(
            zip(undersized, neighbor_rows, strict=True),
            key=lambda row: (_stable_priority(cells[row[0]]["anchor"]), cells[row[0]]["anchor"]),
        )
        for source_index, neighbors in ordered:
            source = cells[source_index]
            if not source["active"] or source["mass"] >= minimum_size:
                continue
            choices: list[tuple[int, float, int, int]] = []
            for local_index in np.atleast_1d(neighbors):
                target_index = active[int(local_index)]
                target = cells[target_index]
                if target_index == source_index or not target["active"]:
                    continue
                combined_mass = source["mass"] + target["mass"]
                category = (
                    0 if target["mass"] < minimum_size and combined_mass <= maximum_size
                    else 1 if combined_mass <= maximum_size
                    else 2 if target["mass"] < minimum_size
                    else 3
                )
                choices.append((category, math.dist(source["position"], target["position"]), _stable_priority(target["anchor"]), target_index))
            if not choices:
                continue
            target_index = min(choices)[3]
            target = cells[target_index]
            combined_mass = source["mass"] + target["mass"]
            target["position"] = tuple(
                (target["position"][dimension] * target["mass"] + source["position"][dimension] * source["mass"])
                / combined_mass
                for dimension in range(4)
            )
            target["mass"] = combined_mass
            target["anchor"] = min(target["anchor"], source["anchor"])
            source["active"] = False
            merged_this_round += 1
        if merged_this_round == 0:
            continue


def pack_voronoi_cohorts(
    database: sqlite3.Connection,
    tile_id: str,
    sites: dict[str, dict[str, Any]],
    minimum_size: int,
    maximum_size: int,
    target_size: int,
    *,
    chunk_size: int = 100_000,
    progress: Callable[[str], None] | None = None,
    flow_query: str = "SELECT home_site,work_site,mass FROM site_flows WHERE tile=?",
    flow_parameters: tuple[object, ...] | None = None,
) -> list[dict[str, Any]]:
    if not 0 < minimum_size <= target_size <= maximum_size:
        raise ValueError("Cohort sizes must satisfy 0 < minimum <= target <= maximum")
    if not sites:
        return []

    coordinates = {site_id: (float(site["x"]), float(site["y"])) for site_id, site in sites.items()}
    seed_rows: list[tuple[str, str, int]] = []
    direct_rows: list[tuple[str, str, int]] = []
    fallback: tuple[int, str, str, int] | None = None
    parameters = flow_parameters if flow_parameters is not None else (tile_id,)
    for home_site, work_site, raw_mass in database.execute(flow_query, parameters):
        mass = int(raw_mass)
        if mass >= minimum_size:
            direct_rows.append((home_site, work_site, mass))
            continue
        priority = _pair_priority(home_site, work_site)
        candidate = (priority, home_site, work_site, mass)
        if fallback is None or candidate < fallback:
            fallback = candidate
        if priority % target_size < mass:
            seed_rows.append((home_site, work_site, mass))
    if fallback is not None and not seed_rows:
        seed_rows.append((fallback[1], fallback[2], fallback[3]))
    if progress:
        progress(f"{tile_id}: sampled {len(seed_rows):,} weighted 4D Voronoi seeds")

    cells: list[dict[str, Any]] = []
    if seed_rows:
        seed_positions = np.asarray([(*coordinates[home], *coordinates[work]) for home, work, _ in seed_rows], dtype=np.float64)
        seed_tree = cKDTree(seed_positions)
        mass_sums = np.zeros(len(seed_rows), dtype=np.int64)
        coordinate_sums = np.zeros((len(seed_rows), 4), dtype=np.float64)
        pending_positions: list[tuple[float, float, float, float]] = []
        pending_masses: list[int] = []

        def flush() -> None:
            if not pending_positions:
                return
            positions = np.asarray(pending_positions, dtype=np.float64)
            masses = np.asarray(pending_masses, dtype=np.int64)
            assigned = np.asarray(seed_tree.query(positions, k=1, workers=-1)[1], dtype=np.int64)
            mass_sums[:] += np.bincount(assigned, weights=masses, minlength=len(seed_rows)).astype(np.int64)
            for dimension in range(4):
                coordinate_sums[:, dimension] += np.bincount(assigned, weights=positions[:, dimension] * masses, minlength=len(seed_rows))
            pending_positions.clear()
            pending_masses.clear()

        processed = 0
        for home_site, work_site, raw_mass in database.execute(flow_query, parameters):
            mass = int(raw_mass)
            if mass >= minimum_size:
                continue
            pending_positions.append((*coordinates[home_site], *coordinates[work_site]))
            pending_masses.append(mass)
            processed += 1
            if len(pending_positions) >= chunk_size:
                flush()
                if progress and processed % 1_000_000 < chunk_size:
                    progress(f"{tile_id}: assigned {processed:,} undersized OD pairs")
        flush()
        for index, mass in enumerate(mass_sums.tolist()):
            if mass <= 0:
                continue
            home_site, work_site, _ = seed_rows[index]
            cells.append({"position": tuple((coordinate_sums[index] / mass).tolist()), "mass": mass, "anchor": f"{home_site}\x1f{work_site}", "active": True})

    for home_site, work_site, mass in direct_rows:
        cells.append({"position": (*coordinates[home_site], *coordinates[work_site]), "mass": mass, "anchor": f"{home_site}\x1f{work_site}", "active": True})
    if not cells:
        return []

    input_mass = sum(cell["mass"] for cell in cells)
    _merge_undersized_cells(cells, minimum_size, maximum_size)
    site_ids = list(sites)
    site_positions = np.asarray([coordinates[site_id] for site_id in site_ids], dtype=np.float64)
    site_tree = cKDTree(site_positions)
    active_cells = [cell for cell in cells if cell["active"]]
    home_positions = np.asarray([cell["position"][:2] for cell in active_cells], dtype=np.float64)
    work_positions = np.asarray([cell["position"][2:] for cell in active_cells], dtype=np.float64)
    home_indices = np.atleast_1d(site_tree.query(home_positions, k=1, workers=-1)[1])
    work_indices = np.atleast_1d(site_tree.query(work_positions, k=1, workers=-1)[1])
    combined: dict[tuple[str, str], int] = defaultdict(int)
    for cell, home_index, work_index in zip(active_cells, home_indices, work_indices, strict=True):
        combined[(site_ids[int(home_index)], site_ids[int(work_index)])] += int(cell["mass"])

    result: list[dict[str, Any]] = []
    for pair, mass in sorted(combined.items()):
        part_count = max(1, math.ceil(mass / maximum_size))
        base, remainder = divmod(mass, part_count)
        if base < minimum_size:
            raise AssertionError(f"Unable to split {mass} workers into {minimum_size}-{maximum_size} cohorts")
        for part in range(part_count):
            result.append({"home": pair[0], "work": pair[1], "mass": base + (1 if part < remainder else 0), "part": part})
    if sum(row["mass"] for row in result) != input_mass:
        raise AssertionError("Voronoi cohort packing did not conserve worker mass")
    return result
