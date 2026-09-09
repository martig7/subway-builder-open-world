from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SELECTION_SCHEMA = "0.1.0"
SELECTION_WORLD_ID = "NEC_CORRIDOR_TILE_PLANNER"
CRS = "EPSG:26918"
TILE_ID_PATTERN = re.compile(r"^NEC_C([MP])(\d{2})_R([MP])(\d{2})$")


@dataclass(frozen=True)
class GridContract:
    crs: str
    origin_x: int
    origin_y: int
    tile_width_m: int
    tile_height_m: int
    halo_m: int
    ownership_convention: str

    def bounds(self, column: int, row: int) -> tuple[int, int, int, int]:
        min_x = self.origin_x + column * self.tile_width_m
        min_y = self.origin_y + row * self.tile_height_m
        return min_x, min_y, min_x + self.tile_width_m, min_y + self.tile_height_m

    def coordinates(self, x: float, y: float) -> tuple[int, int]:
        return (
            math.floor((x - self.origin_x) / self.tile_width_m),
            math.floor((y - self.origin_y) / self.tile_height_m),
        )


@dataclass(frozen=True)
class SelectedTile:
    id: str
    column: int
    row: int
    ownership_projected: tuple[int, int, int, int]


@dataclass(frozen=True)
class Selection:
    schema_version: str
    world_id: str
    grid: GridContract
    tile_ids: tuple[str, ...]
    tiles: tuple[SelectedTile, ...]

    @property
    def tile_by_id(self) -> dict[str, SelectedTile]:
        return {tile.id: tile for tile in self.tiles}

    @property
    def coordinates(self) -> dict[tuple[int, int], str]:
        return {(tile.column, tile.row): tile.id for tile in self.tiles}

    def tile_id_at(self, x: float, y: float) -> str | None:
        return self.coordinates.get(self.grid.coordinates(x, y))


def parse_tile_id(tile_id: str) -> tuple[int, int]:
    match = TILE_ID_PATTERN.fullmatch(tile_id)
    if not match:
        raise ValueError(f"invalid NEC tile ID: {tile_id!r}")
    column_sign, column_value, row_sign, row_value = match.groups()
    column = int(column_value) * (1 if column_sign == "P" else -1)
    row = int(row_value) * (1 if row_sign == "P" else -1)
    return column, row


def _required_int(raw: dict[str, Any], key: str) -> int:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
        raise ValueError(f"grid.{key} must be an integer")
    return int(value)


def _grid_from_export(raw: dict[str, Any]) -> GridContract:
    grid_raw = raw.get("grid")
    if not isinstance(grid_raw, dict):
        raise ValueError("selection export must contain a grid object")
    return GridContract(
        crs=str(raw.get("crs")),
        origin_x=_required_int(grid_raw, "originX"),
        origin_y=_required_int(grid_raw, "originY"),
        tile_width_m=_required_int(grid_raw, "tileWidthM"),
        tile_height_m=_required_int(grid_raw, "tileHeightM"),
        halo_m=_required_int(grid_raw, "haloM"),
        ownership_convention=str(grid_raw.get("ownershipConvention")),
    )


def _validate_contract(grid: GridContract) -> None:
    expected = GridContract(
        crs=CRS,
        origin_x=553400,
        origin_y=4483300,
        tile_width_m=77700,
        tile_height_m=97300,
        halo_m=2000,
        ownership_convention="[min_x,max_x) × [min_y,max_y)",
    )
    if grid != expected:
        raise ValueError(f"selection grid does not match the frozen New York contract: {grid}")


def validate_selection(raw: dict[str, Any], *, expected_tile_count: int | None = 36) -> Selection:
    if raw.get("schemaVersion") != SELECTION_SCHEMA:
        raise ValueError(f"expected selection schema {SELECTION_SCHEMA}, got {raw.get('schemaVersion')!r}")
    if raw.get("worldId") != SELECTION_WORLD_ID:
        raise ValueError(f"expected world ID {SELECTION_WORLD_ID}, got {raw.get('worldId')!r}")

    grid = _grid_from_export(raw)
    _validate_contract(grid)

    tile_ids_raw = raw.get("selectedTileIds")
    selected_tiles_raw = raw.get("selectedTiles")
    if not isinstance(tile_ids_raw, list) or not all(isinstance(value, str) for value in tile_ids_raw):
        raise ValueError("selectedTileIds must be a list of strings")
    if not isinstance(selected_tiles_raw, list):
        raise ValueError("selectedTiles must be a list")
    if len(tile_ids_raw) != len(set(tile_ids_raw)):
        raise ValueError("selectedTileIds contains duplicates")
    if expected_tile_count is not None and len(tile_ids_raw) != expected_tile_count:
        raise ValueError(f"expected {expected_tile_count} selected tiles, got {len(tile_ids_raw)}")
    if {str(value.get("id")) for value in selected_tiles_raw} != set(tile_ids_raw):
        raise ValueError("selectedTileIds and selectedTiles do not contain the same IDs")

    tiles: list[SelectedTile] = []
    for raw_tile in selected_tiles_raw:
        if not isinstance(raw_tile, dict):
            raise ValueError("each selected tile must be an object")
        tile_id = str(raw_tile.get("id"))
        column, row = parse_tile_id(tile_id)
        if raw_tile.get("column") != column or raw_tile.get("row") != row:
            raise ValueError(f"{tile_id} has inconsistent column/row metadata")
        ownership_raw = raw_tile.get("ownershipProjected")
        if not isinstance(ownership_raw, list) or len(ownership_raw) != 4:
            raise ValueError(f"{tile_id} must contain four ownershipProjected values")
        ownership = tuple(int(value) for value in ownership_raw)
        if ownership != grid.bounds(column, row):
            raise ValueError(f"{tile_id} ownershipProjected does not match the grid contract")
        tiles.append(SelectedTile(tile_id, column, row, ownership))

    tiles.sort(key=lambda tile: (tile.row, tile.column))
    return Selection(
        schema_version=str(raw["schemaVersion"]),
        world_id=str(raw["worldId"]),
        grid=grid,
        tile_ids=tuple(tile.id for tile in tiles),
        tiles=tuple(tiles),
    )


def load_selection(path: str | Path, *, expected_tile_count: int | None = 36) -> Selection:
    source = Path(path)
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"unable to read selection export {source}: {error}") from error
    if not isinstance(raw, dict):
        raise ValueError("selection export must contain a JSON object")
    return validate_selection(raw, expected_tile_count=expected_tile_count)
