from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .storage import sha256_value


def _world_validator() -> Draft202012Validator:
    repository_schema = Path(__file__).resolve().parents[3] / "open-world-platform" / "contracts" / "world-definition.schema.json"
    schema_path = repository_schema if repository_schema.is_file() else Path(sys.prefix) / "share" / "open-world" / "contracts" / "world-definition.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


WORLD_VALIDATOR = _world_validator()


def validate_world_definition(definition: Any) -> None:
    errors = sorted(WORLD_VALIDATOR.iter_errors(definition), key=lambda error: str(list(error.path)))
    if errors:
        details = [f"{'.'.join(map(str, error.path)) or 'World Definition'}: {error.message}" for error in errors]
        raise ValueError("Invalid World Definition:\n- " + "\n- ".join(details))


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
    validate_world_definition(definition)
    catalog = json.loads(_contained(world_root, definition["tileViews"]["catalog"]).read_text(encoding="utf-8"))
    tile_ids = [tile.get("id") for tile in catalog.get("tiles", [])]
    if any(not isinstance(tile_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", tile_id) for tile_id in tile_ids) or len(set(tile_ids)) != len(tile_ids):
        raise ValueError("Invalid or duplicate Tile View ID")
    demand = json.loads(_contained(world_root, definition["demand"]["definition"]).read_text(encoding="utf-8"))
    source_lock = json.loads(_contained(world_root, definition["map"]["sourceLock"]).read_text(encoding="utf-8"))
    selected_ids = {tile["id"] for tile in catalog.get("tiles", []) if tile.get("status") == "selected"}
    if definition["tileViews"]["initialTileId"] not in selected_ids:
        raise ValueError("Initial Tile View is not selected")
    context_id = definition["map"].get("worldContextTileId")
    if context_id is not None and context_id not in selected_ids:
        raise ValueError("World context Tile Package is not selected")
    return LoadedWorld(world_root, definition, catalog, demand, source_lock, sha256_value(definition))
