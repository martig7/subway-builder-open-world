from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class GridConfig:
    origin_x: int
    origin_y: int
    tile_width_m: int
    tile_height_m: int
    nyc_column: int
    nyc_row: int

    def bounds(self, column: int, row: int) -> tuple[float, float, float, float]:
        min_x = self.origin_x + column * self.tile_width_m
        min_y = self.origin_y + row * self.tile_height_m
        return min_x, min_y, min_x + self.tile_width_m, min_y + self.tile_height_m

    def coordinates(self, x: float, y: float) -> tuple[int, int]:
        return (
            math.floor((x - self.origin_x) / self.tile_width_m),
            math.floor((y - self.origin_y) / self.tile_height_m),
        )


@dataclass(frozen=True)
class WorldConfig:
    schema_version: str
    world_id: str
    crs: str
    grid: GridConfig
    halo_m: int
    state_fips: str
    state_postal: str
    normal_minimum_intersection_km2: float
    keep_intersecting_slivers: bool
    cohort: dict[str, Any]
    demand: dict[str, Any]


def load_json_yaml(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"{source} must contain JSON-compatible YAML: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{source} must contain an object")
    return value


def load_world_config(path: str | Path) -> WorldConfig:
    raw = load_json_yaml(path)
    try:
        grid_raw = raw["grid"]
        selection = raw["selection"]
        grid = GridConfig(
            origin_x=int(grid_raw["originX"]),
            origin_y=int(grid_raw["originY"]),
            tile_width_m=int(grid_raw["tileWidthM"]),
            tile_height_m=int(grid_raw["tileHeightM"]),
            nyc_column=int(grid_raw["nycColumn"]),
            nyc_row=int(grid_raw["nycRow"]),
        )
        result = WorldConfig(
            schema_version=str(raw["schemaVersion"]),
            world_id=str(raw["worldId"]),
            crs=str(raw["crs"]),
            grid=grid,
            halo_m=int(raw["haloM"]),
            state_fips=str(selection["stateFips"]),
            state_postal=str(selection["statePostal"]),
            normal_minimum_intersection_km2=float(selection["normalMinimumIntersectionKm2"]),
            keep_intersecting_slivers=bool(selection["keepIntersectingSlivers"]),
            cohort=dict(raw["cohort"]),
            demand=dict(raw["demand"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"invalid world configuration {path}: {error}") from error
    validate_world_config(result)
    return result


def validate_world_config(config: WorldConfig) -> None:
    if config.crs != "EPSG:26918":
        raise ValueError("Milestone 0 is frozen to EPSG:26918")
    if (config.grid.tile_width_m, config.grid.tile_height_m) != (77_700, 97_300):
        raise ValueError("Milestone 0 must use the NYC-derived 77,700 m × 97,300 m grid")
    if (config.grid.origin_x, config.grid.origin_y) != (553_400, 4_483_300):
        raise ValueError("Milestone 0 grid origin is frozen")
    if config.halo_m != 2_000:
        raise ValueError("Milestone 0 halo must remain 2 km")
    if config.normal_minimum_intersection_km2 != 1.0:
        raise ValueError("Milestone 0 normal/sliver threshold is frozen at 1 km²")
    if int(config.cohort["nativeMinimumSize"]) != 50 or int(config.cohort["maximumSize"]) != 200:
        raise ValueError("cohort contract must remain minimum 50 / maximum 200")


def load_source_lock(path: str | Path) -> dict[str, Any]:
    raw = load_json_yaml(path)
    sources = raw.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ValueError("source lock must contain a non-empty sources array")
    required = {"filename", "url", "bytes", "sha256", "role"}
    for source in sources:
        missing = required - set(source)
        if missing:
            raise ValueError(f"source lock entry is missing {sorted(missing)}")
    return raw

