"""Build a local, thematic overview mask from NASA's categorical MODIS imagery.

No demand/boundary/routing inputs are changed. WMS images are class rasters,
not screenshots: exact published RGB -> sourceValue lookup only, never a
green-color heuristic. Small patches and sub-pixel precision are intentionally
omitted from this coarse overview product.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
from pathlib import Path
import time
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
import requests
from rasterio.features import shapes
from rasterio.transform import from_bounds
from shapely.geometry import shape, mapping, Polygon, LineString
from shapely import union_all


def simplify_chunk_polygon(polygon, tolerance, bounds):
    """Simplify natural edges, retaining every endpoint on an artificial cut.

    Ordinary polygon simplification can drop a nearly-collinear chunk corner,
    opening a long triangular gap against the independently simplified neighbor.
    Invalid ring combinations fall back to the valid original, never a buffer.
    """
    west, south, east, north = bounds
    def ring_coordinates(ring):
        coords = list(ring.coords)[:-1]
        anchors = [i for i, (x, y) in enumerate(coords)
                   if min(abs(x-west), abs(x-east), abs(y-south), abs(y-north)) < 1e-8]
        if not anchors:
            return list(Polygon(coords).simplify(tolerance, preserve_topology=True).exterior.coords)
        result = []
        for j, start in enumerate(anchors):
            end = anchors[(j+1) % len(anchors)]
            segment = coords[start:end+1] if end > start else coords[start:] + coords[:end+1]
            result.extend(list(LineString(segment).simplify(tolerance).coords)[:-1])
        return result + result[:1]
    candidate = Polygon(ring_coordinates(polygon.exterior),
                        [ring_coordinates(ring) for ring in polygon.interiors])
    return candidate if candidate.is_valid and not candidate.is_empty else polygon


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_digest(data, expected, label):
    if digest(data) != expected:
        raise ValueError(f'{label} SHA256 differs from the pinned source; review before updating the lock')


def palette_lookup(xml, included):
    entries = {}
    for entry in ET.fromstring(xml).iter('ColorMapEntry'):
        rgb = tuple(map(int, entry.attrib['rgb'].split(',')))
        classes = set(map(int, entry.attrib.get('sourceValue', '').split(','))) if entry.attrib.get('sourceValue') else set()
        entries[rgb] = entry.attrib.get('transparent') != 'true' and bool(classes & set(included))
    return entries


def vegetation_mask(rgba, palette):
    rgb = rgba[:, :, :3].astype(np.uint32)
    packed = (rgb[:, :, 0] << 16) | (rgb[:, :, 1] << 8) | rgb[:, :, 2]
    del rgb
    allowed = [(r << 16) | (g << 8) | b for (r, g, b), green in palette.items() if green]
    known = [(r << 16) | (g << 8) | b for r, g, b in palette]
    opaque = rgba[:, :, 3] != 0
    unknown = int(np.count_nonzero(opaque & ~np.isin(packed, known)))
    if unknown:
        raise ValueError(f'{unknown} pixels do not match NASA class colors; refusing interpolated classifications')
    return (np.isin(packed, allowed) & opaque).astype(np.uint8)


def fetch(url, path, params=None):
    if path.exists():
        return path.read_bytes()
    for attempt in range(3):
        try:
            response = requests.get(url, params=params, timeout=180)
            response.raise_for_status()
            data = response.content
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return data
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', type=Path, default=Path('map-creator/sources/world-vegetation.json'))
    parser.add_argument('--data-root', type=Path, default=Path('map-creator/data'))
    parser.add_argument('--candidate', action='store_true', help='Write a review candidate without replacing the pinned artifact')
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    root = args.data_root / 'sources' / 'world-vegetation' / spec['id']
    palette_data = fetch(spec['palette'], root / 'palette.xml')
    verify_digest(palette_data, spec['paletteSha256'], 'NASA palette')
    palette = palette_lookup(palette_data, spec['includedClasses'])
    quadrants = [(-180, 0, 0, 90), (0, 0, 180, 90), (-180, -90, 0, 0), (0, -90, 180, 0)]
    def download(item):
        i, (west, south, east, north) = item
        params = dict(SERVICE='WMS', VERSION='1.3.0', REQUEST='GetMap', FORMAT='image/png',
                      TRANSPARENT='true', LAYERS=spec['layer'], CRS='EPSG:4326', STYLES='',
                      WIDTH=spec['quadrantWidth'], HEIGHT=spec['quadrantHeight'],
                      BBOX=f'{south},{west},{north},{east}', TIME=spec['date'])
        data = fetch(spec['wms'], root / f'quadrant-{i}.png', params)
        verify_digest(data, spec['quadrantSha256'][i], f'NASA quadrant {i}')
        print(json.dumps({'stage': 'download', 'quadrant': i, 'bytes': len(data)}), flush=True)
        return data, requests.Request('GET', spec['wms'], params=params).prepare().url
    with ThreadPoolExecutor(max_workers=2) as pool:
        downloads = list(pool.map(download, enumerate(quadrants)))
    features, sources = [], []
    pixel_count = 0
    for i, ((west, south, east, north), (data, url)) in enumerate(zip(quadrants, downloads)):
        rgba = np.array(Image.open(io.BytesIO(data)).convert('RGBA'))
        if rgba.shape[:2] != (spec['quadrantHeight'], spec['quadrantWidth']):
            raise ValueError('Unexpected NASA raster dimensions')
        mask = vegetation_mask(rgba, palette)
        pixel_count += int(mask.sum())
        transform = from_bounds(west, south, east, north, mask.shape[1], mask.shape[0])
        minimum_area = abs(transform.a * transform.e) * spec['minimumPixels']
        # Bound topology work: connected continental forests can otherwise
        # create enormous polygons with hundreds of thousands of holes.
        # Lock cut vertices while simplifying each chunk, then dissolve the
        # artificial boundaries before client-side low-zoom simplification.
        for row in range(0, mask.shape[0], 256):
            for column in range(0, mask.shape[1], 256):
                chunk = mask[row:row + 256, column:column + 256]
                local_transform = transform * transform.translation(column, row)
                for geom, value in shapes(chunk, mask=chunk.astype(bool), transform=local_transform):
                    polygon = shape(geom)
                    if polygon.area < minimum_area:
                        continue
                    minimum_hole = abs(transform.a * transform.e) * spec['minimumHolePixels']
                    polygon = Polygon(polygon.exterior, [ring for ring in polygon.interiors
                                      if Polygon(ring).area >= minimum_hole])
                    chunk_bounds = (west + column*transform.a, north + (row+chunk.shape[0])*transform.e,
                                    west + (column+chunk.shape[1])*transform.a, north + row*transform.e)
                    polygon = simplify_chunk_polygon(polygon, spec['simplifyDegrees'], chunk_bounds)
                    if not polygon.is_valid or polygon.is_empty:
                        raise ValueError('Invalid vegetation geometry')
                    geometry = json.loads(json.dumps(mapping(polygon)), parse_float=lambda v: round(float(v), 5))
                    if not shape(geometry).is_valid:
                        geometry = mapping(polygon)  # retain precision rather than damage topology
                    features.append({'type': 'Feature', 'properties': {}, 'geometry': geometry})
            print(json.dumps({'stage': 'simplify', 'quadrant': i, 'rows': row + chunk.shape[0],
                              'totalRows': mask.shape[0], 'features': len(features)}), flush=True)
        sources.append({'url': url, 'sha256': digest(data), 'bytes': len(data)})
        print(json.dumps({'stage': 'polygonize', 'quadrant': i, 'features': len(features)}), flush=True)
    print(json.dumps({'stage': 'dissolve-chunk-edges', 'features': len(features)}), flush=True)
    merged = union_all([shape(feature['geometry']) for feature in features], grid_size=.00001)
    if not merged.is_valid:
        raise ValueError('Invalid dissolved vegetation geometry')
    polygons = [merged] if merged.geom_type == 'Polygon' else list(merged.geoms)
    features = [{'type': 'Feature', 'properties': {}, 'geometry': mapping(polygon)} for polygon in polygons]
    payload = {'type': 'FeatureCollection', 'features': features}
    raw = json.dumps(payload, separators=(',', ':')).encode()
    encoded = gzip.compress(raw, mtime=0, compresslevel=9)
    if not args.candidate:
        verify_digest(encoded, spec['artifactSha256'], 'Vegetation artifact')
    output = args.data_root / 'artifacts' / 'world-vegetation'
    output.mkdir(parents=True, exist_ok=True)
    suffix = '.candidate' if args.candidate else ''
    path = output / f'{spec["id"]}{suffix}.geojson.gz'
    path.write_bytes(encoded)
    report = {'id': spec['id'], 'source': spec, 'downloads': sources,
              'paletteSha256': digest(palette_data), 'artifactSha256': digest(encoded),
              'features': len(features), 'vegetationPixels': pixel_count,
              'jsonBytes': len(raw), 'gzipBytes': len(encoded), 'resolutionDegrees': 180 / spec['quadrantWidth']}
    (output / f'{spec["id"]}{suffix}.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'stage': 'complete', **{k: v for k, v in report.items() if k not in {'source', 'downloads'}}}), flush=True)


if __name__ == '__main__':
    main()
