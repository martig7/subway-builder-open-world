"""Deterministic tile ownership and canonical cross-tile cohort compiler."""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from typing import Any, Iterable

from .compile_gateways import choose_gateway
from .config import WorldConfig
from .util import stable_id


@dataclass(frozen=True)
class Cohort:
    id: str
    home_block: str
    work_block: str
    mass: int
    home_tile: str | None
    work_tile: str | None
    home_x: float
    home_y: float
    work_x: float
    work_y: float
    gateway_id: str | None


def class_for_tile(cohort: Cohort, tile_id: str) -> str:
    if cohort.home_tile == tile_id and cohort.work_tile == tile_id:
        return "LOCAL"
    if cohort.home_tile == tile_id:
        return "OUTBOUND"
    if cohort.work_tile == tile_id:
        return "INBOUND"
    return "EXTERNAL"


def compile_cohorts(config: WorldConfig, rows: Iterable[dict[str, Any]]) -> tuple[list[Cohort], dict[str, Any]]:
    """Aggregate equal block pairs and split mass by the configured max size."""
    grouped: dict[tuple[Any, ...], int] = defaultdict(int)
    for row in rows:
        mass = int(row["S000"])
        if mass <= 0:
            continue
        key = (str(row["home_block"]), str(row["work_block"]), float(row["home_x"]), float(row["home_y"]), float(row["work_x"]), float(row["work_y"]))
        grouped[key] += mass
    cohorts: list[Cohort] = []
    report: Counter[str] = Counter()
    for key in sorted(grouped):
        home_block, work_block, home_x, home_y, work_x, work_y = key
        home_tile = config.owner_of(home_x, home_y)
        work_tile = config.owner_of(work_x, work_y)
        total = grouped[key]
        parts = (total + config.maximum_cohort_size - 1) // config.maximum_cohort_size
        for part in range(parts):
            mass = min(config.maximum_cohort_size, total - part * config.maximum_cohort_size)
            cross_tile = home_tile is not None and work_tile is not None and home_tile != work_tile
            gateway = choose_gateway(config, (home_x, home_y), (work_x, work_y)).id if cross_tile else None
            cohort = Cohort(stable_id("cohort", config.clustering_version, home_block, work_block, part), home_block, work_block, mass, home_tile, work_tile, home_x, home_y, work_x, work_y, gateway)
            cohorts.append(cohort)
            report["canonical_mass"] += mass
            for tile in config.tiles:
                report[f"{tile.id}_{class_for_tile(cohort, tile.id)}_mass"] += mass
    return cohorts, dict(report)


def projections(config: WorldConfig, cohorts: Iterable[Cohort], tile_id: str) -> list[dict[str, Any]]:
    """Return one view per canonical cohort; EXTERNAL rows remain aggregate only."""
    config.tile_by_id(tile_id)
    result: list[dict[str, Any]] = []
    for cohort in cohorts:
        classification = class_for_tile(cohort, tile_id)
        if classification == "EXTERNAL":
            continue
        row = asdict(cohort)
        row["classification"] = classification
        row["tile_id"] = tile_id
        # A cross-tile view references one local endpoint and one gateway proxy.
        row["proxy_endpoint"] = "work" if classification == "OUTBOUND" else "home" if classification == "INBOUND" else None
        result.append(row)
    return result
