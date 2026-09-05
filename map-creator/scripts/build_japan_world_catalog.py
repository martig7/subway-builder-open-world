from __future__ import annotations

import argparse
import json
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import GeometryCollection, Polygon, mapping, shape
from shapely.ops import transform


COMPATIBLE_TILE_IDS = {"13": "JP_TOKYO_MAINLAND", "14": "JP_KANAGAWA_MAINLAND"}
MANUAL_CORRIDORS = {("01", "02"): "tunnel-or-ferry", ("46", "47"): "ferry-or-air"}
CATALOG_CRS = "+proj=lcc +lat_1=30 +lat_2=46 +lat_0=38 +lon_0=138 +ellps=GRS80 +units=m +no_defs"
# Ownership includes islands. Visibility/complexity belongs to display LODs.
DEFAULT_MINIMUM_ISLAND_AREA_KM2 = 0.0
DEFAULT_SEAM_CLOSURE_M = 0.0
PREFECTURE_NAMES_JA = {
    "01": "北海道", "02": "青森県", "03": "岩手県", "04": "宮城県", "05": "秋田県",
    "06": "山形県", "07": "福島県", "08": "茨城県", "09": "栃木県", "10": "群馬県",
    "11": "埼玉県", "12": "千葉県", "13": "東京都", "14": "神奈川県", "15": "新潟県",
    "16": "富山県", "17": "石川県", "18": "福井県", "19": "山梨県", "20": "長野県",
    "21": "岐阜県", "22": "静岡県", "23": "愛知県", "24": "三重県", "25": "滋賀県",
    "26": "京都府", "27": "大阪府", "28": "兵庫県", "29": "奈良県", "30": "和歌山県",
    "31": "鳥取県", "32": "島根県", "33": "岡山県", "34": "広島県", "35": "山口県",
    "36": "徳島県", "37": "香川県", "38": "愛媛県", "39": "高知県", "40": "福岡県",
    "41": "佐賀県", "42": "長崎県", "43": "熊本県", "44": "大分県", "45": "宮崎県",
    "46": "鹿児島県", "47": "沖縄県",
}


def tile_id(pref_code: str) -> str:
    return COMPATIBLE_TILE_IDS.get(pref_code, f"JP_PREF_{pref_code}")


def _pref_code(feature: dict) -> str:
    properties = feature["properties"]
    if properties.get("pref_code") is not None:
        return str(properties["pref_code"]).zfill(2)
    identifier = str(properties.get("id", ""))
    if identifier.startswith("JP") and identifier[2:].isdigit():
        return identifier[2:].zfill(2)
    raise ValueError(f"Boundary feature has no prefecture code: {properties}")


def _polygonal(geometry):
    parts = [
        part
        for part in shapely.get_parts(shapely.make_valid(geometry))
        if part.geom_type in {"Polygon", "MultiPolygon"} and not part.is_empty
    ]
    if not parts:
        raise ValueError("Boundary simplification removed every polygonal component")
    return shapely.union_all(parts)


def _filled_and_filtered(geometry, minimum_area_m2: float):
    filled = []
    for part in shapely.get_parts(_polygonal(geometry)):
        if part.geom_type != "Polygon":
            continue
        polygon = Polygon(part.exterior)
        if polygon.area >= minimum_area_m2:
            filled.append(polygon)
    if not filled:
        raise ValueError("Boundary cleanup removed every polygonal component")
    return _polygonal(shapely.union_all(filled))


def build_overlay(
    source: Path,
    tolerance_m: float,
    minimum_island_area_km2: float = DEFAULT_MINIMUM_ISLAND_AREA_KM2,
    seam_closure_m: float = DEFAULT_SEAM_CLOSURE_M,
) -> dict:
    overlay = json.loads(source.read_text(encoding="utf-8"))
    features = sorted(overlay["features"], key=_pref_code)
    forward = Transformer.from_crs("EPSG:4326", "EPSG:6933", always_xy=True).transform
    reverse = Transformer.from_crs("EPSG:6933", "EPSG:4326", always_xy=True).transform
    minimum_area_m2 = minimum_island_area_km2 * 1_000_000
    detailed_by_code = {}
    feature_by_code = {}
    for index, feature in enumerate(features, start=1):
        code = _pref_code(feature)
        print(json.dumps({"stage": "boundary-cleanup", "status": "started", "prefCode": code, "index": index, "total": len(features)}), flush=True)
        metric = transform(forward, shape(feature["geometry"]))
        # A light independent simplification makes validity repair tractable.
        # The final simplification happens only after the shared coverage has
        # been built, so this pass cannot become the published seam geometry.
        reduced = shapely.simplify(metric, max(0.5, tolerance_m / 2), preserve_topology=False)
        detailed = _filled_and_filtered(reduced, minimum_area_m2)
        detailed_by_code[code] = detailed
        feature_by_code[code] = feature
        print(json.dumps({"stage": "boundary-cleanup", "status": "complete", "prefCode": code, "vertices": int(shapely.get_num_coordinates(detailed))}), flush=True)

    national_land = _filled_and_filtered(
        shapely.union_all(list(detailed_by_code.values())),
        minimum_area_m2,
    )
    if seam_closure_m > 0:
        national_land = _filled_and_filtered(
            shapely.buffer(
                shapely.buffer(national_land, seam_closure_m / 2, join_style="mitre"),
                -seam_closure_m / 2,
                join_style="mitre",
            ),
            minimum_area_m2,
        )

    occupied_metric = GeometryCollection()
    exclusive_by_code = {}
    codes = sorted(detailed_by_code)
    for index, code in enumerate(codes, start=1):
        print(json.dumps({"stage": "boundary-overlay", "status": "started", "prefCode": code, "index": index, "total": len(features)}), flush=True)
        exclusive_metric = _polygonal(detailed_by_code[code].difference(occupied_metric))
        exclusive_by_code[code] = exclusive_metric
        occupied_metric = shapely.union_all([occupied_metric, exclusive_metric])

    remainder = national_land.difference(occupied_metric)
    if not remainder.is_empty:
        remainder = _polygonal(remainder)
        detailed_geometries = [detailed_by_code[code] for code in codes]
        detailed_tree = shapely.STRtree(detailed_geometries)
        remainder_by_owner = {code: [] for code in codes}
        remainder_parts = [
            part
            for part in shapely.get_parts(remainder)
            if part.geom_type == "Polygon" and not part.is_empty
        ]
        print(json.dumps({
            "stage": "boundary-remainder",
            "status": "started",
            "partCount": len(remainder_parts),
        }), flush=True)
        representative_points = shapely.point_on_surface(remainder_parts)
        part_indexes, tree_indexes = detailed_tree.query_nearest(
            representative_points,
            all_matches=True,
        )
        owner_index_by_part = {}
        for part_index, tree_index in zip(part_indexes, tree_indexes, strict=True):
            part_number = int(part_index)
            owner_index_by_part[part_number] = min(
                int(tree_index),
                owner_index_by_part.get(part_number, int(tree_index)),
            )
        if len(owner_index_by_part) != len(remainder_parts):
            raise ValueError("Every national remainder part must have a nearest prefecture")
        for part_index, part in enumerate(remainder_parts):
            owner = codes[owner_index_by_part[part_index]]
            remainder_by_owner[owner].append(part)
        for code, parts in remainder_by_owner.items():
            if parts:
                exclusive_by_code[code] = _polygonal(
                    shapely.union_all([exclusive_by_code[code], *parts])
                )
        print(json.dumps({
            "stage": "boundary-remainder",
            "status": "complete",
            "partCount": len(remainder_parts),
            "ownerCount": sum(bool(parts) for parts in remainder_by_owner.values()),
        }), flush=True)

    print(json.dumps({
        "stage": "boundary-final-cleanup",
        "status": "started",
        "prefectureCount": len(codes),
    }), flush=True)
    final_occupied = GeometryCollection()
    final_by_code = {}
    for code in codes:
        cleaned = _filled_and_filtered(exclusive_by_code[code], minimum_area_m2)
        exclusive = _polygonal(cleaned.difference(final_occupied))
        kept_parts = [
            part
            for part in shapely.get_parts(exclusive)
            if part.geom_type == "Polygon" and part.area >= minimum_area_m2
        ]
        if not kept_parts:
            raise ValueError(f"Final boundary cleanup removed prefecture {code}")
        exclusive = _polygonal(shapely.union_all(kept_parts))
        final_by_code[code] = exclusive
        final_occupied = shapely.union_all([final_occupied, exclusive])
    exclusive_by_code = final_by_code
    print(json.dumps({
        "stage": "boundary-final-cleanup",
        "status": "complete",
        "prefectureCount": len(codes),
    }), flush=True)

    coverage_input = [exclusive_by_code[code] for code in codes]
    coverage_valid = shapely.coverage_is_valid(coverage_input, gap_width=0.0)
    topology_method = "shared-coverage-simplification"
    if not coverage_valid:
        invalid_edges = shapely.coverage_invalid_edges(
            coverage_input,
            gap_width=0.0,
        )
        invalid_edge_count = sum(not edge.is_empty for edge in invalid_edges)
        simplified = coverage_input
        topology_method = "exclusive-coverage-pre-simplified"
        print(json.dumps({
            "stage": "coverage-simplification",
            "status": "skipped-invalid-input",
            "prefectureCount": len(codes),
            "invalidEdgeCount": invalid_edge_count,
        }), flush=True)
    else:
        print(json.dumps({
            "stage": "coverage-simplification",
            "status": "started",
            "prefectureCount": len(codes),
            "toleranceM": tolerance_m,
        }), flush=True)
        candidate = shapely.coverage_simplify(
            coverage_input,
            tolerance_m,
            simplify_boundary=True,
        )
        if shapely.coverage_is_valid(candidate, gap_width=0.0):
            simplified = candidate
            print(json.dumps({
                "stage": "coverage-simplification",
                "status": "complete",
                "prefectureCount": len(codes),
                "vertices": int(sum(shapely.get_num_coordinates(item) for item in simplified)),
            }), flush=True)
        else:
            simplified = coverage_input
            topology_method = "exclusive-coverage-pre-simplified"
            print(json.dumps({
                "stage": "coverage-simplification",
                "status": "reverted-invalid-output",
                "prefectureCount": len(codes),
            }), flush=True)

    output_features = []
    published_occupied = GeometryCollection()
    for code, exclusive_metric in zip(codes, simplified, strict=True):
        feature = feature_by_code[code]
        exclusive = transform(reverse, exclusive_metric)
        if not exclusive.is_valid:
            exclusive = _polygonal(exclusive)
        exclusive = _polygonal(exclusive.difference(published_occupied))
        published_occupied = shapely.union_all([published_occupied, exclusive])
        properties = {
            **feature["properties"],
            "pref_code": code,
            "pref_name_ja": feature["properties"].get("pref_name_ja", PREFECTURE_NAMES_JA[code]),
            "tile_id": tile_id(code),
            "overlay_simplification_tolerance_m": tolerance_m,
            "overlay_topology": topology_method,
            "minimum_island_area_km2": minimum_island_area_km2,
            "inland_water_policy": "filled",
            "seam_closure_m": seam_closure_m,
        }
        output_features.append({"type": "Feature", "properties": properties, "geometry": mapping(exclusive)})
        print(json.dumps({"stage": "boundary-overlay", "status": "complete", "prefCode": code, "vertices": int(shapely.get_num_coordinates(exclusive))}), flush=True)
    return {
        "type": "FeatureCollection",
        "name": "japan-prefecture-boundaries.runtime",
        "features": output_features,
    }


def build(
    source: Path,
    tolerance_m: float = 10.0,
    minimum_island_area_km2: float = DEFAULT_MINIMUM_ISLAND_AREA_KM2,
    seam_closure_m: float = DEFAULT_SEAM_CLOSURE_M,
    ownership_additions: Path | None = None,
) -> tuple[dict, dict]:
    overlay = build_overlay(source, tolerance_m, minimum_island_area_km2, seam_closure_m)
    if ownership_additions:
        from open_world_map_creator.geography import apply_ownership_additions
        overlay = apply_ownership_additions(overlay, json.loads(ownership_additions.read_text(encoding='utf-8')))
    features = overlay["features"]
    geometries = {feature["properties"]["pref_code"]: shape(feature["geometry"]) for feature in features}
    neighbor_models: dict[str, list[tuple[str, str]]] = {code: [] for code in geometries}
    catalog_projector = Transformer.from_crs("EPSG:4326", CATALOG_CRS, always_xy=True).transform
    codes = sorted(geometries)
    for index, left in enumerate(codes):
        for right in codes[index + 1 :]:
            method = MANUAL_CORRIDORS.get((left, right))
            shared_boundary = geometries[left].boundary.intersection(geometries[right].boundary).length
            if method is None and geometries[left].distance(geometries[right]) <= 1e-10 and shared_boundary > 1e-8:
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
    parser.add_argument("--minimum-island-area-km2", type=float, default=DEFAULT_MINIMUM_ISLAND_AREA_KM2)
    parser.add_argument("--seam-closure-m", type=float, default=DEFAULT_SEAM_CLOSURE_M)
    parser.add_argument("--ownership-additions", type=Path)
    args = parser.parse_args()
    catalog, overlay = build(
        args.source,
        args.overlay_tolerance_m,
        args.minimum_island_area_km2,
        args.seam_closure_m,
        args.ownership_additions,
    )
    for destination, value in ((args.catalog, catalog), (args.overlay, overlay)):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
