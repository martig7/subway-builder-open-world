from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from . import MAP_CREATOR_RELEASE
from .storage import DataRoot, atomic_json, sha256_value
from .worlds import load_world


REQUIRED_GATES = ("schema", "hashes", "mass", "routing", "reproducibility")


def publish_artifact_set(world_root: Path, run_manifest_path: Path, data_root: DataRoot) -> dict[str, Any]:
    world = load_world(world_root)
    run = json.loads(run_manifest_path.read_text(encoding="utf-8"))
    if run.get("worldDefinitionHash") != world.definition_hash:
        raise ValueError("Run manifest was produced from a different World Definition")
    by_stage = {result["stage"]: result for result in run.get("results", [])}
    packages = by_stage.get("package", {}).get("output", {}).get("tilePackages")
    validation = by_stage.get("verify", {}).get("output", {}).get("validation")
    if not packages:
        raise ValueError("Run manifest has no verified Tile Packages")
    if not isinstance(validation, dict) or any(validation.get(gate) != "passed" for gate in REQUIRED_GATES):
        raise ValueError("Run manifest has not passed every publication gate")
    unsigned = {
        "schemaVersion": 1,
        "worldId": world.definition["identity"]["artifactWorldId"],
        "worldDefinitionHash": world.definition_hash,
        "platformRelease": world.definition["release"]["platformCompatibility"],
        "mapCreatorRevision": MAP_CREATOR_RELEASE,
        "parentArtifactSetId": run.get("parentArtifactSetId"),
        "sources": by_stage.get("acquire", {}).get("output", {}).get("sources", []),
        "tiles": packages,
        "reports": by_stage["verify"]["output"].get("reports", []),
        "validation": validation,
    }
    artifact_set_id = f"sha256-{sha256_value(unsigned)}"
    manifest = {"artifactSetId": artifact_set_id, **unsigned}
    destination = data_root.artifacts / world.definition["identity"]["worldId"] / artifact_set_id
    if destination.exists():
        existing = json.loads((destination / "artifact-set.json").read_text(encoding="utf-8"))
        if existing != manifest:
            raise ValueError(f"Artifact Set identity collision: {artifact_set_id}")
        return existing
    staging = destination.with_name(f".{artifact_set_id}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    atomic_json(staging / "artifact-set.json", manifest)
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(staging, destination)
    return manifest
