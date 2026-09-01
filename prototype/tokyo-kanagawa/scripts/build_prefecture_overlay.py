#!/usr/bin/env python3
"""Build smooth, mutually exclusive Tokyo/Kanagawa mainland overlay polygons."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely import coverage_is_valid, coverage_simplify, make_valid, union_all
from shapely.geometry import MultiPolygon, box, mapping, shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "generated" / "prefecture-admin-level4.geojson"
DEFAULT_OUTPUT = ROOT.parent / "japan" / "generated" / "tokyo-kanagawa-test" / "world-boundary-overlay.json"
PREFECTURES = {"13": "Tokyo", "14": "Kanagawa"}
MAINLAND_EXTENTS = {
    "13": box(138.9, 35.35, 140.05, 36.0),
    "14": box(138.8, 34.9, 139.9, 35.75),
}
METRIC_CRS = "EPSG:6677"


def polygon_parts(geometry: Any) -> list[Any]:
    if geometry.geom_type == "Polygon":
        return [geometry]
    if geometry.geom_type in {"MultiPolygon", "GeometryCollection"}:
        return [part for child in geometry.geoms for part in polygon_parts(child)]
    return []


def municipality_union(features: list[dict[str, Any]], pref_code: str) -> Any:
    municipalities = []
    for feature in features:
        properties = feature.get("properties", {})
        municipality_code = str(properties.get("ref") or "")
        if (
            properties.get("boundary") == "administrative"
            and properties.get("admin_level") == "7"
            and municipality_code.startswith(pref_code)
        ):
            municipalities.append(make_valid(shape(feature["geometry"])))
    if not municipalities:
        raise ValueError(f"No OSM municipality boundaries found for prefecture {pref_code}")

    dissolved = make_valid(union_all(municipalities))
    mainland_parts = [
        part for part in polygon_parts(dissolved)
        if part.intersects(MAINLAND_EXTENTS[pref_code])
    ]
    if not mainland_parts:
        raise ValueError(f"No mainland geometry found for prefecture {pref_code}")
    return make_valid(MultiPolygon(mainland_parts))


def build(source_path: Path, output_path: Path, tolerance_m: float) -> dict[str, Any]:
    source = json.loads(source_path.read_text(encoding="utf-8"))
    geographic = [municipality_union(source["features"], code) for code in PREFECTURES]
    forward = Transformer.from_crs("EPSG:4326", METRIC_CRS, always_xy=True).transform
    inverse = Transformer.from_crs(METRIC_CRS, "EPSG:4326", always_xy=True).transform
    metric = [transform(forward, geometry) for geometry in geographic]
    if not coverage_is_valid(metric):
        raise ValueError("OSM municipality unions do not form a valid non-overlapping coverage")

    simplified = list(coverage_simplify(metric, tolerance_m, simplify_boundary=True))
    if not coverage_is_valid(simplified):
        raise ValueError("Topology-preserving simplification produced an invalid coverage")
    overlap_m2 = simplified[0].intersection(simplified[1]).area
    if overlap_m2 != 0:
        raise ValueError(f"Prefecture overlay polygons overlap by {overlap_m2} square metres")

    features = []
    for pref_code, geometry in zip(PREFECTURES, simplified, strict=True):
        features.append({
            "type": "Feature",
            "properties": {
                "pref_code": pref_code,
                "name": PREFECTURES[pref_code],
                "source": "OpenStreetMap admin_level=7 municipality coverage",
                "simplification_tolerance_m": tolerance_m,
            },
            "geometry": mapping(transform(inverse, geometry)),
        })
    output = {"type": "FeatureCollection", "features": features}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {
        "output": str(output_path),
        "bytes": output_path.stat().st_size,
        "toleranceM": tolerance_m,
        "overlapM2": overlap_m2,
        "coverageValid": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--tolerance-m", type=float, default=10.0)
    args = parser.parse_args()
    if args.tolerance_m < 0:
        parser.error("simplification tolerance must be non-negative")
    print(json.dumps(build(args.source, args.output, args.tolerance_m), indent=2))


if __name__ == "__main__":
    main()
