"""Explicit computation inputs and precomputed display-only geometry."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import shape, mapping
from shapely.ops import transform

REPOSITORY = Path(__file__).resolve().parents[3]
SOURCE_ROOT = Path(os.environ.get("OW_MAP_DATA_ROOT", REPOSITORY / "map-creator" / "data")) / "sources"
# Keep each simpler level for one more zoom step before adding detail.
DISPLAY_LEVELS = ((0, 2000), (7, 500), (9, 100), (11, 25), (13, 0))
METRIC_CRS = "+proj=lcc +lat_1=30 +lat_2=46 +lat_0=38 +lon_0=138 +ellps=GRS80 +units=m"


def computation_boundary(world_root, source_root=None):
    world_root = Path(world_root)
    definition = json.loads((world_root / "world.json").read_text(encoding="utf-8"))
    key = definition.get("map", {}).get("computationBoundary")
    if not key:
        # Compatibility for Worlds that have not declared distinct geometry.
        return world_root / "geography" / "prefectures.geojson"
    root = Path(source_root or SOURCE_ROOT).resolve()
    target = (root / key).resolve()
    if root not in target.parents:
        raise ValueError("Computation boundary escapes the source store")
    if not target.is_file():
        raise FileNotFoundError(f"Full computation geometry is missing: {target}; do not substitute display LODs")
    return target


def ownership_boundary(world_root):
    """Full approved Tile View outlines, never a zoom-selected display LOD.

    Raw administrative/physical geometry remains available for computation, but
    only this World-owned geometry decides demand's final tile membership.
    """
    root = Path(world_root).resolve()
    definition = json.loads((root / 'world.json').read_text(encoding='utf-8'))
    key = definition.get('tileViews', {}).get('ownershipBoundary')
    if not key:
        return computation_boundary(root)
    target = (root / key).resolve()
    if root not in target.parents:
        raise ValueError('Ownership boundary escapes the World directory')
    if not target.is_file():
        raise FileNotFoundError(f'Authoritative ownership geometry is missing: {target}')
    return target


def display_lods(source, progress=print, metric_crs=METRIC_CRS):
    forward = Transformer.from_crs("EPSG:4326", metric_crs, always_xy=True).transform
    inverse = Transformer.from_crs(metric_crs, "EPSG:4326", always_xy=True).transform
    features = source["features"]
    geometries = [shapely.set_precision(transform(forward, shape(f["geometry"])), .01) for f in features]
    if not shapely.coverage_is_valid(geometries):
        progress("[geometry] noding shared display edges once before LOD simplification")
        tree = shapely.STRtree(geometries)
        faces = shapely.get_parts(shapely.polygonize(shapely.get_parts(
            shapely.union_all(shapely.boundary(geometries)))))
        owned = [[] for _ in geometries]
        for face in faces:
            hits = tree.query(face.representative_point(), predicate="covered_by")
            if len(hits):
                owned[min(hits)].append(face)
        geometries = [shapely.union_all(parts) for parts in owned]
    if not shapely.coverage_is_valid(geometries) or any(g.is_empty for g in geometries):
        raise ValueError("Display source cannot form a valid shared-edge coverage")
    result = {"type": "FeatureCollection", "schemaVersion": 1, "purpose": "display-only",
              "lodVersion": "precomputed-boundary-lod-v1", "lods": []}
    for min_zoom, tolerance in DISPLAY_LEVELS:
        reduced = shapely.coverage_simplify(geometries, tolerance) if tolerance else geometries
        if not shapely.coverage_is_valid(reduced):
            raise ValueError(f"Display LOD at zoom {min_zoom} broke shared edges")
        level = {"type": "FeatureCollection", "minZoom": min_zoom, "toleranceMetres": tolerance,
                 "vertexCount": int(sum(shapely.get_num_coordinates(g) for g in reduced)),
                 "features": [{"type": "Feature", "properties": f["properties"],
                               "geometry": mapping(transform(inverse, g))}
                              for f, g in zip(features, reduced, strict=True)]}
        result["lods"].append(level)
        progress(f"[geometry] zoom {min_zoom}: {level['vertexCount']} vertices ({tolerance} m)")
    # Legacy readers get the coarsest display, never full computation geometry.
    result["features"] = result["lods"][0]["features"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--computation-source", type=Path, required=True)
    parser.add_argument("--computation-output", type=Path, required=True)
    parser.add_argument("--display-source", type=Path, required=True)
    parser.add_argument("--display-output", type=Path, required=True)
    parser.add_argument("--display-crs", default=METRIC_CRS,
                        help="World-specific metric CRS for display simplification; defaults to Japan's catalog CRS")
    args = parser.parse_args()
    if args.display_output.resolve() in {args.computation_source.resolve(), args.computation_output.resolve(), args.display_source.resolve()}:
        raise ValueError("Display output must not overwrite source/computation geometry")
    args.computation_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.computation_source, args.computation_output)
    with args.computation_output.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    result = display_lods(json.loads(args.display_source.read_text(encoding="utf-8")),
                          lambda message: print(message, flush=True), args.display_crs)
    result["computationSourceSha256"] = checksum
    args.display_output.parent.mkdir(parents=True, exist_ok=True)
    args.display_output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"computationBytes": args.computation_output.stat().st_size, "computationSha256": checksum,
                      "displayBytes": args.display_output.stat().st_size}), flush=True)


if __name__ == "__main__":
    main()
