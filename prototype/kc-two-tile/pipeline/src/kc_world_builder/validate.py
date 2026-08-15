from __future__ import annotations

from collections import Counter
from typing import Iterable

from .compile_demand import Cohort, class_for_tile, projections
from .config import WorldConfig, validate_config


def validate_conservation(config: WorldConfig, cohorts: Iterable[Cohort], expected_mass: int | None = None) -> dict[str, int]:
    validate_config(config)
    materialized = list(cohorts)
    ids = [cohort.id for cohort in materialized]
    if len(ids) != len(set(ids)):
        raise ValueError("canonical cohort IDs are not unique")
    canonical = sum(cohort.mass for cohort in materialized)
    if expected_mass is not None and canonical != expected_mass:
        raise ValueError(f"canonical mass {canonical} does not equal normalized mass {expected_mass}")
    totals: Counter[str] = Counter(canonical_mass=canonical)
    for tile in config.tiles:
        tile_projections = projections(config, materialized, tile.id)
        by_id = {row["id"]: row for row in tile_projections}
        for cohort in materialized:
            classification = class_for_tile(cohort, tile.id)
            if classification == "EXTERNAL":
                if cohort.id in by_id:
                    raise ValueError(f"external cohort {cohort.id} materialized in {tile.id}")
                continue
            row = by_id.get(cohort.id)
            if row is None or row["classification"] != classification or row["mass"] != cohort.mass:
                raise ValueError(f"projection invariant failed for {cohort.id} in {tile.id}")
            totals[f"{tile.id}_{classification}_mass"] += cohort.mass
    # Each inter-tile relationship has exactly the two expected projections.
    for cohort in materialized:
        involved = [tile.id for tile in config.tiles if class_for_tile(cohort, tile.id) != "EXTERNAL"]
        if cohort.home_tile and cohort.work_tile and cohort.home_tile != cohort.work_tile and len(involved) != 2:
            raise ValueError(f"cross-tile cohort {cohort.id} lacks paired projections")
    return dict(totals)
