from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Bounds:
    min_x: float
    min_y: float
    max_x: float
    max_y: float

    def contains(self, x: float, y: float, *, include_max_x: bool = False) -> bool:
        # Half-open x bounds make a seam point have one and only one owner.
        x_ok = self.min_x <= x <= self.max_x if include_max_x else self.min_x <= x < self.max_x
        return x_ok and self.min_y <= y <= self.max_y

    def expanded(self, metres: float) -> "Bounds":
        return Bounds(self.min_x - metres, self.min_y - metres, self.max_x + metres, self.max_y + metres)


@dataclass(frozen=True)
class Tile:
    id: str
    ownership: Bounds
    halo_m: int

    @property
    def halo(self) -> Bounds:
        return self.ownership.expanded(self.halo_m)


@dataclass(frozen=True)
class Gateway:
    id: str
    x: float
    y: float


@dataclass(frozen=True)
class WorldConfig:
    schema_version: str
    crs: str
    data_vintage: str
    tiles: tuple[Tile, ...]
    gateways: tuple[Gateway, ...]
    maximum_cohort_size: int
    clustering_version: str
    native_minimum_cohort_size: int
    native_cluster_cell_m: int
    point_merge_distance_m: int

    def tile_by_id(self, tile_id: str) -> Tile:
        return next(tile for tile in self.tiles if tile.id == tile_id)

    def owner_of(self, x: float, y: float) -> str | None:
        for index, tile in enumerate(self.tiles):
            if tile.ownership.contains(x, y, include_max_x=index == len(self.tiles) - 1):
                return tile.id
        return None

    def location_kind(self, x: float, y: float) -> tuple[str, str | None]:
        owner = self.owner_of(x, y)
        if owner:
            return "OWNER", owner
        halos = [tile.id for tile in self.tiles if tile.halo.contains(x, y, include_max_x=True)]
        return ("HALO", halos[0]) if halos else ("OUTSIDE", None)


def _read_mapping(path: Path) -> dict[str, Any]:
    # JSON is valid YAML 1.2.  Keeping this file in JSON-shaped YAML avoids a
    # mandatory PyYAML dependency for a reproducible bootstrap compiler.
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"{path} must contain JSON-compatible YAML; install/use a converter for broader YAML") from error
    if not isinstance(result, dict):
        raise ValueError("world config must be an object")
    return result


def load_world_config(path: str | Path) -> WorldConfig:
    raw = _read_mapping(Path(path))
    try:
        tiles = tuple(Tile(str(row["id"]), Bounds(*map(float, row["ownership"])), int(row["halo_m"])) for row in raw["tiles"])
        gateways = tuple(Gateway(str(row["id"]), float(row["x"]), float(row["y"])) for row in raw["gateways"])
        cohort = raw["cohort"]
        config = WorldConfig(
            str(raw["schema_version"]), str(raw["crs"]), str(raw["data_vintage"]),
            tiles, gateways, int(cohort["maximum_size"]), str(cohort["clustering_version"]),
            int(cohort["native_minimum_size"]), int(cohort["native_cell_size_m"]),
            int(cohort["point_merge_distance_m"]),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"invalid world config {path}: {error}") from error
    validate_config(config)
    return config


def validate_config(config: WorldConfig) -> None:
    if config.crs != "EPSG:26915" or len(config.tiles) != 2:
        raise ValueError("prototype requires exactly two EPSG:26915 tiles")
    if len({tile.id for tile in config.tiles}) != len(config.tiles):
        raise ValueError("tile IDs must be unique")
    if any(tile.halo_m != 2000 for tile in config.tiles):
        raise ValueError("prototype requires immutable 2 km halos")
    for tile in config.tiles:
        if tile.ownership.max_x - tile.ownership.min_x != 25000 or tile.ownership.max_y - tile.ownership.min_y != 25000:
            raise ValueError(f"{tile.id} must be exactly 25 km by 25 km")
    west, east = config.tiles
    if west.ownership.max_x != east.ownership.min_x or west.ownership.min_y != east.ownership.min_y or west.ownership.max_y != east.ownership.max_y:
        raise ValueError("tiles must be adjacent, non-overlapping ownership squares")
    if len(config.gateways) != 3 or any(gateway.x != west.ownership.max_x for gateway in config.gateways):
        raise ValueError("prototype requires three gateways on the shared border")
    if config.maximum_cohort_size < 1:
        raise ValueError("maximum cohort size must be positive")
    if config.native_minimum_cohort_size < 1:
        raise ValueError("native minimum cohort size must be positive")
    if config.native_cluster_cell_m < 1:
        raise ValueError("native cluster cell size must be positive")
    if config.point_merge_distance_m < 1:
        raise ValueError("point merge distance must be positive")
