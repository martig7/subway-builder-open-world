"""Bounded worker processes for independent owner placement on a Runner."""
from .frontage_sites import build_owner_frontage
from .physical_land import PhysicalLandIndex
from .road_support import RoadSupportCache

_roads = None
_land = None


def initialize(config, osm_root, cache_root, pins, land_path, land_sha):
    global _roads, _land
    _roads = RoadSupportCache(config, osm_root, cache_root)
    _roads.pins = pins
    _land = PhysicalLandIndex.read(land_path) if land_path else None
    if _land:
        _land.source_sha256 = land_sha


def build(arguments):
    owner, source_groups, boundary, building_path, policy, supplements, cache_root = arguments
    return owner, build_owner_frontage(owner, source_groups, boundary, building_path, _roads, policy,
        physical_land=_land, supplemental_buildings=supplements, cache_root=cache_root,
        progress=lambda message: print(message, flush=True))
