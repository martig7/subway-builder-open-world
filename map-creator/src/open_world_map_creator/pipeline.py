from __future__ import annotations

from pathlib import Path
from typing import Any

from .runners import InProcessRunner, SubprocessRunner
from .stages import plan_world
from .storage import DataRoot, atomic_json, sha256_value


RUNNERS = {"in-process": InProcessRunner, "subprocess": SubprocessRunner}


def build_world(world_root: Path, data_root: DataRoot, tile_id: str | None = None, runner_name: str = "in-process") -> dict[str, Any]:
    world, plans = plan_world(world_root, data_root, tile_id)
    data_root.create()
    try:
        runner = RUNNERS[runner_name]()
    except KeyError as error:
        raise ValueError(f"Unknown Runner profile: {runner_name}") from error
    results = []
    for plan in plans:
        if plan.status == "blocked":
            raise ValueError(f"Stage is blocked by unresolved inputs: {plan.name}")
        manifest = {
            "schemaVersion": 1,
            "worldRoot": str(world.root),
            "worldDefinitionHash": world.definition_hash,
            "stage": plan.name,
            "stageKey": plan.key,
            "tileId": tile_id,
        }
        result = runner.run(manifest)
        result_path = data_root.work / world.definition["identity"]["worldId"] / plan.key / "result.json"
        atomic_json(result_path, result)
        results.append(result)
    run_manifest = {"schemaVersion": 1, "worldId": world.definition["identity"]["worldId"], "worldDefinitionHash": world.definition_hash, "tileId": tile_id, "runner": runner.name, "results": results}
    run_manifest["runId"] = f"sha256-{sha256_value(run_manifest)}"
    atomic_json(data_root.work / world.definition["identity"]["worldId"] / run_manifest["runId"] / "run-manifest.json", run_manifest)
    return run_manifest
