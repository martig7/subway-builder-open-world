"""Compatibility redirect to the centralized Map Creator routing module.

Remove after external callers migrate to ``ow-map build``.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_CENTRAL_SOURCE = Path(__file__).resolve().parents[4] / "map-creator" / "src"
if str(_CENTRAL_SOURCE) not in sys.path:
    sys.path.insert(0, str(_CENTRAL_SOURCE))

from open_world_map_creator.routing import enrich_generated_road_driving


def enrich_nec_driving(catalog_path: str | Path, maps_dir: str | Path, demand_dir: str | Path, **options: Any) -> dict[str, Any]:
    return enrich_generated_road_driving(
        catalog_path,
        maps_dir,
        demand_dir,
        report_namespace="nec",
        consumer_manifest_id="local.nec-corridor-open-world",
        demand_report_name="nec-demand.json",
        build_hash_prefix="nec-road-v1",
        **options,
    )
