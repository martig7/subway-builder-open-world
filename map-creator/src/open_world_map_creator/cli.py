from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .pipeline import build_world
from .publication import publish_artifact_set
from .stages import plan_world
from .storage import DataRoot


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="ow-map")
    command.add_argument("command", choices=("plan", "build", "verify", "publish"))
    command.add_argument("--world", type=Path, required=True)
    command.add_argument("--tile")
    command.add_argument("--runner", default="in-process")
    command.add_argument("--run-manifest", type=Path)
    command.add_argument("--data-root", type=Path, default=Path(os.environ.get("OW_MAP_DATA_ROOT", Path(__file__).parents[3] / "data")))
    return command


def main() -> None:
    args = parser().parse_args()
    data_root = DataRoot(args.data_root)
    if args.command == "publish":
        if not args.run_manifest:
            raise SystemExit("--run-manifest is required for publish")
        print(json.dumps(publish_artifact_set(args.world, args.run_manifest, data_root), indent=2))
        return
    if args.command == "build":
        print(json.dumps(build_world(args.world, data_root, args.tile, args.runner), indent=2))
        return
    world, plans = plan_world(args.world, data_root, args.tile)
    result = {"worldId": world.definition["identity"]["worldId"], "worldDefinitionHash": world.definition_hash, "stages": [plan.__dict__ for plan in plans]}
    if args.command == "verify" and any(plan.status != "current" for plan in plans):
        raise SystemExit("Artifact work is stale or incomplete")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
