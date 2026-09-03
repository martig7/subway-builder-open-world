from __future__ import annotations

import argparse
import json
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import GeometryCollection, mapping, shape
from shapely.ops import transform


COMPATIBLE_TILE_IDS = {"13": "JP_TOKYO_MAINLAND", "14": "JP_KANAGAWA_MAINLAND"}
MANUAL_CORRIDORS = {("01", "02"): "tunnel-or-ferry", ("46", "47"): "ferry-or-air"}
CATALOG_CRS = "+proj=lcc +lat_1=30 +lat_2=46 +lat_0=38 +lon_0=138 +ellps=GRS80 +units=m +no_defs"


def tile_id(pref_code: str) -> str:
    return COMPATIBLE_TILE_IDS.get(pref_code, f"JP_PREF_{pref_code}")


def _polygonal(geometry):
    parts = [
        part
        for part in shapely.get_parts(shapely.make_valid(geometry))
        if part.geom_type in {"Polygon", "MultiPolygon"} and not part.is_empty
    ]
    if not parts:
        raise ValueError("Boundary simplification removed every polygonal component")
    return shapely.union_all(parts)


def build_overlay(source: Path, tolerance_m: float) -> dict:
    overlay = json.loads(source.read_text(encoding="utf-8"))
    features = sorted(overlay["features"], key=lambda feature: feature["properties"]["pref_code"])
    forward = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True).transform
    reverse = Transformer.from_crs("EPSG:6933", "EPSG:4326", always_xy=True).transform
    occupied_metric = GeometryCollection()
    occupied_wgs84 = GeometryCollection()
    output_features = []
    for index, feature in enumerate(features, start=1):
        code = feature["properties"]["pref_code"]
        print(json.dumps({"stage": "boundary-overlay", "status": "started", "prefCode": code, "index": index, "total": len(features)}), flush=True)
        metric = transform(forward, shape(feature["geometry"]))
        # Simplify before validity repair so million-vertex source dissolves do
        # not make GEOS spend minutes inspecting zero-area statistical slivers.
        detailed = _polygonal(shapely.simplify(metric, tolerance_m, preserve_topology=False))
        exclusive_metric = _polygonal(detailed.difference(occupied_metric))
        occupied_metric = shapely.union_all([occupied_metric, exclusive_metric])
        # Projection is non-linear: differently noded shared line segments can
        # become slightly different chords after inverse projection. Repeat the
        # ordered subtraction in the serialized CRS so the runtime polygons are
        # themselves a valid, exactly disjoint coverage.
        projected_back = _polygonal(transform(reverse, exclusive_metric))
        exclusive = _polygonal(projected_back.difference(occupied_wgs84))
        occupied_wgs84 = shapely.union_all([occupied_wgs84, exclusive])
        properties = {
            **feature["properties"],
            "overlay_simplification_tolerance_m": tolerance_m,
            "overlay_topology": "ordered-disjoint-coverage",
        }
        output_features.append({"type": "Feature", "properties": properties, "geometry": mapping(exclusive)})
        print(json.dumps({"stage": "boundary-overlay", "status": "complete", "prefCode": code, "vertices": int(shapely.get_num_coordinates(exclusive))}), flush=True)
    return {
        "type": "FeatureCollection",
        "name": "japan-prefecture-boundaries.runtime",
        "features": output_features,
    }


def build(source: Path, tolerance_m: float = 10.0) -> tuple[dict, dict]:
    overlay = build_overlay(source, tolerance_m)
    features = overlay["features"]
    geometries = {feature["properties"]["pref_code"]: shape(feature["geometry"]) for feature in features}
    neighbor_models: dict[str, list[tuple[str, str]]] = {code: [] for code in geometries}
    catalog_projector = Transformer.from_crs("EPSG:4326", CATALOG_CRS, always_xy=True).transform
    codes = sorted(geometries)
    for index, left in enumerate(codes):
        for right in codes[index + 1 :]:
            method = MANUAL_CORRIDORS.get((left, right))
            if method is None and geometries[left].distance(geometries[right]) <= 0.015:
                method = "land"
            if method:
                neighbor_models[left].append((right, method))
                neighbor_models[right].append((left, method))
    tiles = []
    for feature in features:
        properties = feature["properties"]
        code = properties["pref_code"]
        geometry = geometries[code]
        projected = transform(catalog_projector, geometry)
        west, south, east, north = geometry.bounds
        initial_view = {
            "longitude": round((west + east) / 2, 6),
            "latitude": round((south + north) / 2, 6),
            "zoom": 8.5,
            "bearing": 0,
        }
        if code == "13":
            initial_view = {"longitude": 139.7671, "latitude": 35.6812, "zoom": 11.2, "bearing": 0}
        elif code == "14":
            initial_view = {"longitude": 139.638, "latitude": 35.4478, "zoom": 11.0, "bearing": 0}
        identifier = tile_id(code)
        tiles.append({
            "id": identifier,
            "gameCityCode": identifier,
            "prefCode": code,
            "name": properties["pref_name_ja"],
            "bounds": [round(west, 7), round(south, 7), round(east, 7), round(north, 7)],
            "haloBounds": [round(west - 0.05, 7), round(south - 0.05, 7), round(east + 0.05, 7), round(north + 0.05, 7)],
            "ownershipProjected": [round(value, 3) for value in projected.bounds],
            "initialView": initial_view,
            "neighbors": [{"direction": method, "tileId": tile_id(other)} for other, method in sorted(neighbor_models[code])],
            "routingCorridors": [{"kind": method, "tileId": tile_id(other)} for other, method in sorted(neighbor_models[code])],
            "buildShards": [{"id": f"{identifier}_SHARD_{shard + 1:02d}"} for shard in range(len(geometry.geoms) if geometry.geom_type == "MultiPolygon" else 1)],
            "status": "selected",
            "readiness": "demand-evidence-ready" if code not in {"13", "14"} else "ready-compatible-package",
        })
    catalog = {
        "schemaVersion": 1,
        "worldId": "JP_NATIONAL_OPEN_WORLD",
        "crs": CATALOG_CRS,
        "name": "Japan Open World",
        "scope": "All 47 prefectures; packages become playable independently",
        "initialView": {"longitude": 139.7671, "latitude": 35.6812, "zoom": 5.2, "bearing": 0},
        "minZoom": 0.01,
        "maxZoom": 15,
        "tiles": tiles,
    }
    return catalog, overlay


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--overlay", type=Path, required=True)
    parser.add_argument("--overlay-tolerance-m", type=float, default=10.0)
    args = parser.parse_args()
    catalog, overlay = build(args.source, args.overlay_tolerance_m)
    for destination, value in ((args.catalog, catalog), (args.overlay, overlay)):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
