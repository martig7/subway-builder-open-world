from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pyproj import Transformer
from shapely.geometry import box, mapping
from shapely.ops import transform

from .selection import Selection


def _load_states(boundary_path: str | Path, crs: str) -> Any:
    import geopandas as gpd

    path = Path(boundary_path).resolve()
    source = f"zip://{path.as_posix()}" if path.suffix.lower() == ".zip" else str(path)
    states = gpd.read_file(source)
    return states.to_crs(crs)


def build_catalog(selection: Selection, boundary_path: str | Path | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    inverse = Transformer.from_crs(selection.grid.crs, "EPSG:4326", always_xy=True)
    states = _load_states(boundary_path, selection.grid.crs) if boundary_path else None
    tiles: list[dict[str, Any]] = []
    coverage_features: list[dict[str, Any]] = []

    for tile in selection.tiles:
        min_x, min_y, max_x, max_y = tile.ownership_projected
        ownership = box(min_x, min_y, max_x, max_y)
        halo = box(
            min_x - selection.grid.halo_m,
            min_y - selection.grid.halo_m,
            max_x + selection.grid.halo_m,
            max_y + selection.grid.halo_m,
        )
        ownership_wgs84 = transform(inverse.transform, ownership)
        center = ownership_wgs84.centroid
        boundary = [
            [round(longitude, 8), round(latitude, 8)]
            for longitude, latitude in ownership_wgs84.exterior.coords
        ]
        state_touches: list[dict[str, Any]] = []
        if states is not None:
            touched = states[states.geometry.intersects(ownership)]
            for _, state in touched.iterrows():
                intersection = state.geometry.intersection(ownership)
                state_touches.append({
                    "postal": str(state["STUSPS"]),
                    "fips": str(state["STATEFP"]).zfill(2),
                    "intersectionKm2": round(intersection.area / 1_000_000, 6),
                })
            state_touches.sort(key=lambda item: item["postal"])

        tiles.append({
            "id": tile.id,
            "gameCityCode": tile.id,
            "name": f"Grid {tile.column}, {tile.row}",
            "column": tile.column,
            "row": tile.row,
            "status": "selected",
            "stateTouches": state_touches,
            "ownershipProjected": list(tile.ownership_projected),
            "haloProjected": list(halo.bounds),
            "bounds": [round(value, 8) for value in ownership_wgs84.bounds],
            "boundary": boundary,
            "initialView": {
                "longitude": round(center.x, 8),
                "latitude": round(center.y, 8),
                "zoom": 9,
                "bearing": 0,
            },
            "neighbors": [],
        })
        coverage_features.append({
            "type": "Feature",
            "id": tile.id,
            "properties": {
                "id": tile.id,
                "column": tile.column,
                "row": tile.row,
                "stateTouches": [item["postal"] for item in state_touches],
            },
            "geometry": mapping(ownership_wgs84),
        })

    by_coordinate = {(tile["column"], tile["row"]): tile for tile in tiles}
    for tile in tiles:
        for delta_column, delta_row, direction in ((0, 1, "north"), (1, 0, "east"), (0, -1, "south"), (-1, 0, "west")):
            neighbor = by_coordinate.get((tile["column"] + delta_column, tile["row"] + delta_row))
            if neighbor:
                tile["neighbors"].append({"direction": direction, "tileId": neighbor["id"]})

    tiles.sort(key=lambda item: (item["row"], item["column"]))
    jurisdictions = sorted({state["postal"] for tile in tiles for state in tile["stateTouches"]})
    catalog = {
        "schemaVersion": "0.1.0",
        "worldId": "NEC_CORRIDOR_LODES_PROTOTYPE",
        "prototype": True,
        "crs": selection.grid.crs,
        "minZoom": 0.01,
        "maxZoom": 15,
        "initialView": {
            "center": [
                round(sum(tile["initialView"]["longitude"] for tile in tiles) / len(tiles), 8),
                round(sum(tile["initialView"]["latitude"] for tile in tiles) / len(tiles), 8),
            ],
            "zoom": 7,
        },
        "grid": {
            "originX": selection.grid.origin_x,
            "originY": selection.grid.origin_y,
            "tileWidthM": selection.grid.tile_width_m,
            "tileHeightM": selection.grid.tile_height_m,
            "ownershipConvention": selection.grid.ownership_convention,
            "haloM": selection.grid.halo_m,
            "bboxColumns": [min(tile.column for tile in selection.tiles), max(tile.column for tile in selection.tiles)],
            "bboxRows": [min(tile.row for tile in selection.tiles), max(tile.row for tile in selection.tiles)],
        },
        "selection": {
            "sourceSchemaVersion": selection.schema_version,
            "sourceWorldId": selection.world_id,
            "selectedCount": len(selection.tiles),
            "jurisdictions": jurisdictions,
        },
        "tiles": tiles,
    }
    coverage = {"type": "FeatureCollection", "name": "NEC ownership grid", "features": coverage_features}
    return catalog, coverage


def write_catalog(catalog: dict[str, Any], coverage: dict[str, Any], catalog_path: str | Path, coverage_path: str | Path) -> None:
    catalog_target = Path(catalog_path)
    coverage_target = Path(coverage_path)
    catalog_target.parent.mkdir(parents=True, exist_ok=True)
    coverage_target.parent.mkdir(parents=True, exist_ok=True)
    catalog_target.write_text(json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    coverage_target.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
