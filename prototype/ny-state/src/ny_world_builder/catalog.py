from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import geopandas as gpd
from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform

from .config import WorldConfig
from .util import atomic_write_text, stable_tile_id, write_json


def _wgs84_geometry(geometry: Any, crs: str) -> Any:
    transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    return transform(transformer.transform, geometry)


def _svg_path(geometry: Any, project: Any) -> str:
    polygons = list(geometry.geoms) if geometry.geom_type == "MultiPolygon" else [geometry]
    commands: list[str] = []
    for polygon in polygons:
        for ring in [polygon.exterior, *polygon.interiors]:
            points = [project(x, y) for x, y in ring.coords]
            if not points:
                continue
            commands.append(f"M {points[0][0]:.2f} {points[0][1]:.2f}")
            commands.extend(f"L {x:.2f} {y:.2f}" for x, y in points[1:])
            commands.append("Z")
    return " ".join(commands)


def _coverage_svg(config: WorldConfig, state_geometry: Any, tiles: list[dict[str, Any]]) -> str:
    width, height, margin = 1200, 900, 70
    min_x = min(tile["ownershipProjected"][0] for tile in tiles)
    min_y = min(tile["ownershipProjected"][1] for tile in tiles)
    max_x = max(tile["ownershipProjected"][2] for tile in tiles)
    max_y = max(tile["ownershipProjected"][3] for tile in tiles)
    scale = min((width - 2 * margin) / (max_x - min_x), (height - 2 * margin) / (max_y - min_y))

    def project(x: float, y: float) -> tuple[float, float]:
        return margin + (x - min_x) * scale, height - margin - (y - min_y) * scale

    state_path = _svg_path(state_geometry, project)
    rows = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">',
        '<rect width="1200" height="900" fill="#101820"/>',
        '<text x="70" y="38" fill="#f4f7fb" font-family="system-ui,sans-serif" font-size="24" font-weight="700">New York — NYC-scale ownership grid</text>',
        '<text x="70" y="61" fill="#a9b8c7" font-family="system-ui,sans-serif" font-size="13">PROTOTYPE · EPSG:26918 · 77.7 × 97.3 km · 33 normal + 2 sliver cells</text>',
        f'<path d="{state_path}" fill="#23415a" stroke="#87a9c4" stroke-width="1.5" fill-rule="evenodd"/>',
    ]
    for tile in tiles:
        x1, y1 = project(tile["ownershipProjected"][0], tile["ownershipProjected"][3])
        x2, y2 = project(tile["ownershipProjected"][2], tile["ownershipProjected"][1])
        is_nyc = tile["isNycBaseTile"]
        stroke = "#ffd166" if is_nyc else ("#ff6b6b" if tile["status"] == "sliver" else "#8fe3ff")
        dash = ' stroke-dasharray="8 5"' if tile["status"] == "sliver" else ""
        rows.append(
            f'<rect x="{x1:.2f}" y="{y1:.2f}" width="{x2-x1:.2f}" height="{y2-y1:.2f}" '
            f'fill="none" stroke="{stroke}" stroke-width="{3 if is_nyc else 1.2}"{dash}/>'
        )
        center_x, center_y = (x1 + x2) / 2, (y1 + y2) / 2
        label = escape(f"{tile['column']},{tile['row']}")
        rows.append(
            f'<text x="{center_x:.2f}" y="{center_y:.2f}" fill="{stroke}" text-anchor="middle" '
            f'font-family="ui-monospace,monospace" font-size="11">{label}</text>'
        )
    rows.extend([
        '<rect x="860" y="820" width="16" height="16" fill="none" stroke="#ffd166" stroke-width="3"/><text x="885" y="833" fill="#dce7ef" font-family="system-ui,sans-serif" font-size="13">NYC base tile</text>',
        '<rect x="1000" y="820" width="16" height="16" fill="none" stroke="#ff6b6b" stroke-width="2" stroke-dasharray="5 3"/><text x="1025" y="833" fill="#dce7ef" font-family="system-ui,sans-serif" font-size="13">sliver</text>',
        '</svg>',
        '',
    ])
    return "\n".join(rows)


def build_catalog(
    config: WorldConfig,
    boundary_zip: str | Path,
    catalog_path: str | Path,
    coverage_path: str | Path,
    javascript_path: str | Path,
    svg_path: str | Path,
) -> dict[str, Any]:
    states = gpd.read_file(f"zip://{Path(boundary_zip).resolve().as_posix()}")
    selected = states[states["STUSPS"] == config.state_postal]
    if len(selected) != 1:
        raise ValueError(f"expected one {config.state_postal} boundary, found {len(selected)}")
    state_geometry = selected.to_crs(config.crs).geometry.iloc[0]
    state_geometry_wgs84 = _wgs84_geometry(state_geometry, config.crs)
    min_x, min_y, max_x, max_y = state_geometry.bounds
    grid = config.grid
    columns = range(
        math.floor((min_x - grid.origin_x) / grid.tile_width_m),
        math.floor((max_x - grid.origin_x) / grid.tile_width_m) + 1,
    )
    rows = range(
        math.floor((min_y - grid.origin_y) / grid.tile_height_m),
        math.floor((max_y - grid.origin_y) / grid.tile_height_m) + 1,
    )

    tiles: list[dict[str, Any]] = []
    coverage_features: list[dict[str, Any]] = []
    for row in rows:
        for column in columns:
            ownership = box(*grid.bounds(column, row))
            intersection_km2 = state_geometry.intersection(ownership).area / 1_000_000
            if intersection_km2 <= 0:
                continue
            status = "normal" if intersection_km2 > config.normal_minimum_intersection_km2 else "sliver"
            if status == "sliver" and not config.keep_intersecting_slivers:
                continue
            tile_id = stable_tile_id(column, row)
            min_tile_x, min_tile_y, max_tile_x, max_tile_y = ownership.bounds
            halo = box(
                min_tile_x - config.halo_m,
                min_tile_y - config.halo_m,
                max_tile_x + config.halo_m,
                max_tile_y + config.halo_m,
            )
            ownership_wgs84 = _wgs84_geometry(ownership, config.crs)
            center = ownership_wgs84.centroid
            tile = {
                "id": tile_id,
                "gameCityCode": tile_id,
                "name": f"Grid {column}, {row}",
                "cityName": f"New York Open World — {column}, {row}",
                "description": f"NYC-scale ownership tile at grid column {column}, row {row}",
                "population": 0,
                "column": column,
                "row": row,
                "status": status,
                "isNycBaseTile": column == grid.nyc_column and row == grid.nyc_row,
                "stateIntersectionKm2": round(intersection_km2, 6),
                "ownershipProjected": [min_tile_x, min_tile_y, max_tile_x, max_tile_y],
                "haloProjected": list(halo.bounds),
                "bounds": [round(value, 8) for value in ownership_wgs84.bounds],
                "initialView": {
                    "longitude": round(center.x, 8),
                    "latitude": round(center.y, 8),
                    "zoom": 9,
                    "bearing": 0,
                },
                "initialViewState": {
                    "zoom": 9,
                    "latitude": round(center.y, 8),
                    "longitude": round(center.x, 8),
                    "bearing": 0,
                },
                "neighbors": [],
            }
            tiles.append(tile)
            coverage_features.append({
                "type": "Feature",
                "id": tile_id,
                "properties": {
                    "id": tile_id,
                    "gameCityCode": tile["gameCityCode"],
                    "column": column,
                    "row": row,
                    "status": status,
                    "stateIntersectionKm2": tile["stateIntersectionKm2"],
                },
                "geometry": mapping(ownership_wgs84),
            })

    by_coordinate = {(tile["column"], tile["row"]): tile for tile in tiles}
    for tile in tiles:
        for delta_column, delta_row, direction in ((0, 1, "north"), (1, 0, "east"), (0, -1, "south"), (-1, 0, "west")):
            neighbor = by_coordinate.get((tile["column"] + delta_column, tile["row"] + delta_row))
            if neighbor:
                tile["neighbors"].append({"direction": direction, "tileId": neighbor["id"]})

    tiles.sort(key=lambda tile: (tile["row"], tile["column"]))
    normal_count = sum(tile["status"] == "normal" for tile in tiles)
    sliver_count = sum(tile["status"] == "sliver" for tile in tiles)
    catalog = {
        "schemaVersion": "1.0.0",
        "id": config.world_id,
        "worldId": config.world_id,
        "name": "New York State open-world prototype",
        "prototype": True,
        "crs": config.crs,
        "minZoom": 5,
        "maxZoom": 15,
        "initialView": {
            "center": [round(state_geometry_wgs84.centroid.x, 8), round(state_geometry_wgs84.centroid.y, 8)],
            "zoom": 5.5,
        },
        "context": [],
        "grid": {
            "originX": grid.origin_x,
            "originY": grid.origin_y,
            "tileWidthM": grid.tile_width_m,
            "tileHeightM": grid.tile_height_m,
            "ownershipConvention": "[min_x,max_x) x [min_y,max_y)",
            "haloM": config.halo_m,
            "bboxColumns": [min(columns), max(columns)],
            "bboxRows": [min(rows), max(rows)],
            "bboxCellCount": len(columns) * len(rows),
        },
        "selection": {
            "statePostal": config.state_postal,
            "normalMinimumIntersectionKm2": config.normal_minimum_intersection_km2,
            "addressableCount": len(tiles),
            "normalCount": normal_count,
            "sliverCount": sliver_count,
        },
        "tiles": tiles,
    }
    if (len(tiles), normal_count, sliver_count, len(columns) * len(rows)) != (35, 33, 2, 63):
        raise ValueError(
            "frozen grid gate failed: expected 35 addressable / 33 normal / 2 sliver / 63 bbox cells, "
            f"got {len(tiles)} / {normal_count} / {sliver_count} / {len(columns) * len(rows)}"
        )
    if not any(tile["isNycBaseTile"] and tile["status"] == "normal" for tile in tiles):
        raise ValueError("NYC base tile (0,0) is missing or not normal")

    coverage = {
        "type": "FeatureCollection",
        "name": "PROTOTYPE New York NYC-scale ownership grid",
        "features": coverage_features,
    }
    write_json(catalog_path, catalog)
    write_json(coverage_path, coverage)
    atomic_write_text(svg_path, _coverage_svg(config, state_geometry, tiles))
    module_text = (
        "// PROTOTYPE — generated by ny-world-m0; do not edit by hand.\n"
        f"export const NY_TILE_CATALOG = Object.freeze({json.dumps(catalog, separators=(',', ':'))});\n"
        "export default NY_TILE_CATALOG;\n"
    )
    atomic_write_text(javascript_path, module_text)
    return catalog
