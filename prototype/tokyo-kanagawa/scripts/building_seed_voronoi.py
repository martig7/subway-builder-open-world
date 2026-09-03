"""Compatibility import for the centralized building-site compiler."""

from __future__ import annotations

import sys
from pathlib import Path


MAP_CREATOR_SRC = Path(__file__).resolve().parents[3] / "map-creator" / "src"
if str(MAP_CREATOR_SRC) not in sys.path:
    sys.path.insert(0, str(MAP_CREATOR_SRC))

from open_world_map_creator.demand.building_sites import *  # noqa: F403,E402
