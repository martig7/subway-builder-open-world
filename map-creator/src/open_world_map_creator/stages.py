from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import MAP_CREATOR_RELEASE
from .demand import demand_adapter
from .storage import DataRoot, atomic_json, sha256_value
from .worlds import LoadedWorld, load_world


STAGES = ("validate", "acquire", "geography", "demand-evidence", "map-assets", "road-enrichment", "package", "verify")


@dataclass(frozen=True)
class StagePlan:
    name: str
    key: str
    dependencies: tuple[str, ...]
    status: str


def stage_key(world: LoadedWorld, name: str, tile_id: str | None) -> str:
    relevant = {
        "release": MAP_CREATOR_RELEASE,
        "stage": name,
        "worldDefinitionHash": world.definition_hash,
        "tileId": tile_id,
        "map": world.definition["map"] if name in {"map-assets", "road-enrichment", "package", "verify"} else None,
        "demand": world.definition["demand"] if name in {"demand-evidence", "road-enrichment", "package", "verify"} else None,
    }
    return sha256_value(relevant)


def source_lock_issues(value: Any, location: str = "sources") -> list[str]:
    issues: list[str] = []
    if isinstance(value, dict):
        if "sha256" in value and value["sha256"] in (None, ""):
            issues.append(f"{location}.sha256 is unresolved")
        lock_status = str(value.get("lockStatus", ""))
        if any(word in lock_status for word in ("needs", "must-resolve", "unlocked")):
            issues.append(f"{location}.lockStatus={lock_status}")
        for key, child in value.items():
            issues.extend(source_lock_issues(child, f"{location}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            issues.extend(source_lock_issues(child, f"{location}[{index}]"))
    return issues


def plan_world(world_root: Path, data_root: DataRoot, tile_id: str | None = None) -> tuple[LoadedWorld, list[StagePlan]]:
    world = load_world(world_root)
    known_ids = {tile["id"] for tile in world.tile_views}
    if tile_id and tile_id not in known_ids:
        raise ValueError(f"Unknown Tile View: {tile_id}")
    plans: list[StagePlan] = []
    previous: tuple[str, ...] = ()
    blocked = False
    lock_issues = source_lock_issues(world.source_lock)
    for name in STAGES:
        key = stage_key(world, name, tile_id)
        marker = data_root.work / world.definition["identity"]["worldId"] / key / "result.json"
        if name == "acquire" and lock_issues:
            blocked = True
        status = "blocked" if blocked else "current" if marker.is_file() else "stale"
        plans.append(StagePlan(name, key, previous, status))
        previous = (name,)
    return world, plans


def execute_stage(manifest: dict[str, Any]) -> dict[str, Any]:
    world = load_world(Path(manifest["worldRoot"]))
    name = manifest["stage"]
    tile_id = manifest.get("tileId")
    if name == "validate":
        output = {"selectedTileCount": len(world.selected_tiles), "initialTileId": world.definition["tileViews"]["initialTileId"]}
    elif name == "acquire":
        issues = source_lock_issues(world.source_lock)
        if issues:
            raise ValueError("Source lock is incomplete: " + "; ".join(issues))
        output = {"sourceLock": "complete"}
    elif name == "geography":
        tiles = world.tile_views if tile_id is None else [tile for tile in world.tile_views if tile["id"] == tile_id]
        output = {"tileIds": [tile["id"] for tile in tiles], "discontinuousTileIds": [tile["id"] for tile in tiles if tile.get("buildShards")]}
    elif name == "demand-evidence":
        output = demand_adapter(world.definition["demand"]["adapter"]).normalize(world)
    else:
        raise ValueError(f"{name} requires materialized stage inputs; refusing placeholder output")
    return {"schemaVersion": 1, "stage": name, "stageKey": manifest["stageKey"], "worldDefinitionHash": world.definition_hash, "output": output}
