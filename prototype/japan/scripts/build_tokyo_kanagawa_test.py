#!/usr/bin/env python3
"""Compatibility entry point for Tokyo/Kanagawa e-Stat demand preparation."""

from __future__ import annotations

import sys
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "map-creator" / "src"))

from open_world_map_creator.demand.estat_japan_prefecture import (  # noqa: E402
    BoundaryOwnershipIndex,
    assign_prefecture,
    main,
    mesh_center,
    number,
    relocate_into_boundary,
)


if __name__ == "__main__":
    arguments = list(sys.argv[1:])
    if "--boundary-source" not in arguments:
        arguments.extend([
            "--boundary-source",
            str(REPOSITORY_ROOT / "worlds" / "tokyo-kanagawa" / "geography" / "world-boundary-overlay.json"),
        ])
    if "--output" not in arguments:
        arguments.extend([
            "--output",
            str(REPOSITORY_ROOT / "prototype" / "japan" / "generated" / "tokyo-kanagawa-test"),
        ])
    main(arguments)
