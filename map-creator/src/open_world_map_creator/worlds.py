from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .storage import sha256_value


@dataclass(frozen=True)
class LoadedWorld:
    root: Path
    definition: dict[str, Any]
    catalog: dict[str, Any]
    demand: dict[str, Any]
    source_lock: dict[str, Any]
    definition_hash: str

    @property
    def selected_tiles(self) -> list[dict[str, Any]]:
        return [tile for tile in self.catalog.get("tiles", []) if tile.get("status") == "selected"]

    @property
    def tile_views(self) -> list[dict[str, Any]]:
        return list(self.catalog.get("tiles", []))


def _contained(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"World path escapes its directory: {relative}")
    return candidate


def load_world(root: Path) -> LoadedWorld:
    world_root = root.resolve()
    definition = json.loads((world_root / "world.json").read_text(encoding="utf-8"))
    if definition.get("schemaVersion") != 1:
        raise ValueError("Unsupported World Definition schema")
    catalog = json.loads(_contained(world_root, definition["tileViews"]["catalog"]).read_text(encoding="utf-8"))
    demand = json.loads(_contained(world_root, definition["demand"]["definition"]).read_text(encoding="utf-8"))
    source_lock = json.loads(_contained(world_root, definition["map"]["sourceLock"]).read_text(encoding="utf-8"))
    selected_ids = {tile["id"] for tile in catalog.get("tiles", []) if tile.get("status") == "selected"}
    if definition["tileViews"]["initialTileId"] not in selected_ids:
        raise ValueError("Initial Tile View is not selected")
    return LoadedWorld(world_root, definition, catalog, demand, source_lock, sha256_value(definition))
