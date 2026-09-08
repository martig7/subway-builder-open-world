"""Explicit computation inputs and precomputed display-only geometry."""
import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import shape, mapping, MultiPolygon, Polygon
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


def apply_ownership_additions(source, additions):
    """Apply reviewed missing-land components without stealing another owner's land."""
    import copy
    output = copy.deepcopy(source)
    features = {f['properties']['pref_code']: f for f in output['features']}
    geometries = {code: shape(f['geometry']) for code, f in features.items()}
    for feature in additions['features']:
        code = feature['properties']['pref_code']
        addition = shape(feature['geometry'])
        if code not in geometries or addition.is_empty or not addition.is_valid or addition.geom_type not in ('Polygon','MultiPolygon'):
            raise ValueError('Invalid ownership addition')
        for other, geometry in geometries.items():
            if other != code and addition.intersection(geometry).area > 1e-14:
                raise ValueError(f'Ownership addition overlaps {other}')
        if not geometries[code].covers(addition):
            geometries[code] = shapely.union_all([geometries[code], addition])
            features[code]['geometry'] = mapping(geometries[code])
    return output


def unowned_boundary_holes(geometries):
    """Distinguish unfilled water holes from legitimate neighboring enclaves."""
    geometries = list(geometries)
    tree = shapely.STRtree(geometries)
    voids = []
    for geometry in geometries:
        for part in shapely.get_parts(geometry):
            for ring in part.interiors:
                hole = Polygon(ring)
                hits = tree.query(hole, predicate='intersects')
                covered = shapely.union_all([geometries[int(i)] for i in hits])
                remaining = hole.difference(covered)
                if remaining.area > 0:
                    voids.append(remaining)
    return voids


def _visible_islands(geometries, minimum_area):
    """Cull sub-resolution detached islands only in a display copy.

    Keep the largest part of every owner and all shared-border components, so
    hiding a small island never erases an entire prefecture or opens a land seam.
    """
    if minimum_area <= 0:
        return geometries, 0
    tree = shapely.STRtree(geometries)
    visible, hidden = [], 0
    for owner, geometry in enumerate(geometries):
        parts = list(shapely.get_parts(geometry))
        largest = max(range(len(parts)), key=lambda i: parts[i].area)
        kept = []
        for i, part in enumerate(parts):
            shared = (part.area < minimum_area and i != largest
                      and any(int(hit) != owner for hit in tree.query(part, predicate='intersects')))
            if part.area >= minimum_area or i == largest or shared:
                kept.append(part)
            else:
                hidden += 1
        visible.append(kept[0] if len(kept) == 1 else MultiPolygon(kept))
    return visible, hidden


def shared_dividers(geometries, owner_ids, coordinate_transform=None):
    """Extract each shared land border once from a noded coverage, before reprojection."""
    tree = shapely.STRtree(geometries)
    features = []
    for left, geometry in enumerate(geometries):
        for right in sorted(int(i) for i in tree.query(geometry, predicate='intersects') if int(i) > left):
            shared = geometry.boundary.intersection(geometries[right].boundary)
            lines = [part for part in shapely.get_parts(shared)
                     if part.geom_type in ('LineString', 'LinearRing') and part.length > 0]
            if not lines:
                continue
            line = shapely.line_merge(shapely.union_all(lines))
            if coordinate_transform:
                line = transform(coordinate_transform, line)
            features.append({'type': 'Feature', 'properties': {'owners': [str(owner_ids[left]), str(owner_ids[right])]},
                             'geometry': mapping(line)})
    return {'type': 'FeatureCollection', 'features': features,
            'vertexCount': int(sum(shapely.get_num_coordinates(shape(f['geometry'])) for f in features))}


def offshore_selection(geometries, distance=2500):
    """Extend display hit areas into water; never move an existing land owner.

    Offshore overlaps have stable input-order ownership. They are invisible:
    the renderer masks these selection polygons with the native land tiles.
    Enclaves and all shared inland edges remain in their original owner.
    """
    land = shapely.union_all(geometries)
    allocated = land
    result = []
    for geometry in geometries:
        outer = geometry.buffer(distance, quad_segs=2).simplify(distance / 3, preserve_topology=True)
        extra = outer.difference(allocated)
        selected = geometry.union(extra)
        result.append(selected)
        allocated = allocated.union(extra)
    return result


def add_offshore_selection(overlay, metric_crs=METRIC_CRS):
    if overlay.get('purpose') != 'display-only':
        raise ValueError('Offshore selection requires display-only geometry')
    level = next(level for level in overlay['lods'] if level['minZoom'] == 7)
    forward = Transformer.from_crs('EPSG:4326', metric_crs, always_xy=True).transform
    inverse = Transformer.from_crs(metric_crs, 'EPSG:4326', always_xy=True).transform
    geometries = [transform(forward, shape(f['geometry'])) for f in level['features']]
    selected = offshore_selection(geometries)
    features = [{**feature, 'geometry': mapping(shapely.set_precision(transform(inverse, geometry), .00001))}
                for feature, geometry in zip(level['features'], selected, strict=True)]
    return {**overlay, 'selection': {'version': 'offshore-selection-v1', 'offshoreMetres': 2500,
            'features': features, 'vertexCount': int(sum(shapely.get_num_coordinates(shape(f['geometry'])) for f in features))}}


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
              "lodVersion": "precomputed-boundary-lod-islands-v2", "lods": []}
    for min_zoom, tolerance in DISPLAY_LEVELS:
        reduced = shapely.coverage_simplify(geometries, tolerance) if tolerance else geometries
        reduced, hidden = _visible_islands(reduced, tolerance * tolerance)
        if not shapely.coverage_is_valid(reduced):
            raise ValueError(f"Display LOD at zoom {min_zoom} broke shared edges")
        level = {"type": "FeatureCollection", "minZoom": min_zoom, "toleranceMetres": tolerance,
                 "minimumDetachedIslandAreaM2": tolerance * tolerance, "hiddenSmallIslandCount": hidden,
                 "vertexCount": int(sum(shapely.get_num_coordinates(g) for g in reduced)),
                 "features": [{"type": "Feature", "properties": f["properties"],
                               "geometry": mapping(transform(inverse, g))}
                              for f, g in zip(features, reduced, strict=True)]}
        owners = [f['properties'].get('pref_code', f['properties'].get('prefCode', f['properties'].get('id'))) for f in features]
        level['dividers'] = shared_dividers(reduced, owners, inverse)
        result["lods"].append(level)
        progress(f"[geometry] zoom {min_zoom}: {level['vertexCount']} vertices ({tolerance} m)")
    # Legacy readers get the coarsest display, never full computation geometry.
    result["features"] = result["lods"][0]["features"]
    return add_offshore_selection(quantize_display_overlay(result), metric_crs)


def quantize_display_overlay(overlay, grid_size=0.00001):
    """Snap decorative coordinates with topology repair, never ownership data.

    Decimal rounding alone can collapse narrow rings or create crossings.
    GEOS precision reduction nodes those crossings on the common grid first.
    """
    if overlay.get('purpose') != 'display-only' or not overlay.get('lods'):
        raise ValueError('Quantization requires explicit display-only LODs')
    levels = []
    for level in overlay['lods']:
        features = []
        for feature in level['features']:
            geometry = shapely.set_precision(shape(feature['geometry']), grid_size)
            if geometry.is_empty or not geometry.is_valid or geometry.geom_type not in ('Polygon', 'MultiPolygon'):
                raise ValueError('Quantization erased or invalidated a display owner')
            features.append({**feature, 'geometry': mapping(geometry)})
        levels.append({**level, 'features': features,
                       'vertexCount': int(sum(shapely.get_num_coordinates(shape(f['geometry'])) for f in features))})
    return {**overlay, 'lodVersion': 'quantized-display-boundaries-v1',
            'quantizationDegrees': grid_size, 'lods': levels, 'features': levels[0]['features']}


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
