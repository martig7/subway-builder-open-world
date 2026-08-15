"""Small, streaming GeoJSON halo clipper for fixture maps.

Production OSM/PBF and Overture conversion remains an external, pinned Depot
stage. This module intentionally handles ordinary GeoJSON fixtures without
requiring GIS bindings or loading an entire source document at once.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any, Iterator

from .config import Bounds, WorldConfig
from .util import canonical_json, sha256_file, write_json


def _coordinates(value: Any) -> Iterator[tuple[float, float]]:
    if isinstance(value, list) and len(value) >= 2 and isinstance(value[0], (int, float)):
        yield float(value[0]), float(value[1])
    elif isinstance(value, list):
        for child in value:
            yield from _coordinates(child)


def _intersects(bounds: Bounds, geometry: dict[str, Any]) -> bool:
    return any(bounds.contains(x, y, include_max_x=True) for x, y in _coordinates(geometry.get("coordinates", [])))


def iter_feature_collection(path: str | Path) -> Iterator[dict[str, Any]]:
    """A conservative parser for newline-delimited GeoJSON feature fixtures."""
    with Path(path).open(encoding="utf-8") as input_file:
        for number, line in enumerate(input_file, 1):
            if line.strip():
                feature = json.loads(line)
                if feature.get("type") != "Feature":
                    raise ValueError(f"{path}:{number}: expected NDGeoJSON Feature")
                yield feature


def build_halo_assets(config: WorldConfig, features_path: str | Path, destination: str | Path) -> dict[str, dict[str, int | str]]:
    destination = Path(destination)
    # Re-read each fixture stream instead of retaining all features. This is
    # linear in source size and constant in feature-count memory.
    report: dict[str, dict[str, int | str]] = {}
    for tile in config.tiles:
        tile_dir = destination / tile.id
        tile_dir.mkdir(parents=True, exist_ok=True)
        clipped = (feature for feature in iter_feature_collection(features_path) if _intersects(tile.halo, feature.get("geometry", {})))
        roads: list[dict[str, Any]] = []
        buildings: list[dict[str, Any]] = []
        # Per-tile output data necessarily lives at least until gzip serialization;
        # GeoJSON fixtures are deliberately small. Real builds use Depot stages.
        for feature in clipped:
            target = buildings if feature.get("properties", {}).get("kind") == "building" else roads
            target.append(feature)
        for filename, values in (("roads.geojson.gz", {"type": "FeatureCollection", "features": roads}), ("buildings_index.bin.gz", buildings)):
            output_path = tile_dir / filename
            with output_path.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as zipped:
                zipped.write(canonical_json(values))
        report[tile.id] = {"roads": len(roads), "buildings": len(buildings), "roads_sha256": sha256_file(tile_dir / "roads.geojson.gz"), "buildings_sha256": sha256_file(tile_dir / "buildings_index.bin.gz")}
    write_json(destination / "map-build-manifest.json", report)
    return report
