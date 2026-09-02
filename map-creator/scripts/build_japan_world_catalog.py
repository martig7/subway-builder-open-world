from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely.geometry import shape


COMPATIBLE_TILE_IDS = {"13": "JP_TOKYO_MAINLAND", "14": "JP_KANAGAWA_MAINLAND"}
MANUAL_CORRIDORS = {("01", "02"): "tunnel-or-ferry", ("46", "47"): "ferry-or-air"}


def tile_id(pref_code: str) -> str:
    return COMPATIBLE_TILE_IDS.get(pref_code, f"JP_PREF_{pref_code}")


def build(source: Path) -> tuple[dict, dict]:
    overlay = json.loads(source.read_text(encoding="utf-8"))
    features = sorted(overlay["features"], key=lambda feature: feature["properties"]["pref_code"])
    geometries = {feature["properties"]["pref_code"]: shape(feature["geometry"]) for feature in features}
    neighbor_models: dict[str, list[tuple[str, str]]] = {code: [] for code in geometries}
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
        "crs": "+proj=lcc +lat_1=30 +lat_2=46 +lat_0=38 +lon_0=138 +ellps=GRS80 +units=m +no_defs",
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
    args = parser.parse_args()
    catalog, overlay = build(args.source)
    for destination, value in ((args.catalog, catalog), (args.overlay, overlay)):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
