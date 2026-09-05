"""Check chunk-cut interiors against the original categorical raster."""
import gzip
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image
from shapely.geometry import shape, Point
from shapely.strtree import STRtree
from shapely import prepare, covers
from build_world_vegetation import palette_lookup, vegetation_mask


def audit():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', action='store_true')
    args = parser.parse_args()
    spec = json.loads(Path('map-creator/sources/world-vegetation.json').read_text())
    root = Path('map-creator/data/sources/world-vegetation') / spec['id']
    suffix = '.candidate' if args.candidate else ''
    artifact = Path('map-creator/data/artifacts/world-vegetation') / f'{spec["id"]}{suffix}.geojson.gz'
    data = json.loads(gzip.decompress(artifact.read_bytes()))
    geometries = np.array([shape(f['geometry']) for f in data['features']], dtype=object)
    prepare(geometries)
    tree = STRtree(geometries)
    palette = palette_lookup((root / 'palette.xml').read_bytes(), spec['includedClasses'])
    missing, checked = [], 0
    for quadrant in range(4):
        mask = vegetation_mask(np.array(Image.open(root / f'quadrant-{quadrant}.png').convert('RGBA')), palette)
        west, north = (-180 if quadrant % 2 == 0 else 0), (90 if quadrant < 2 else 0)
        step = 180 / spec['quadrantWidth']
        points = []
        for column in range(256, mask.shape[1], 256):
            for row in range(4, mask.shape[0] - 4, 16):
                # Only interiors with a vegetation margin on BOTH sides: no
                # legitimate forest edge or small-patch removal at this cut.
                if mask[row-3:row+4, column-3:column+4].all():
                    for offset in [-.25, 0, .25]:
                        points.append(Point(west+(column+offset)*step, north-(row+.5)*step))
        for row in range(256, mask.shape[0], 256):
            for column in range(4, mask.shape[1] - 4, 16):
                if mask[row-3:row+4, column-3:column+4].all():
                    for offset in [-.25, 0, .25]:
                        points.append(Point(west+(column+.5)*step, north-(row+offset)*step))
        hits = tree.query(points)
        covered = set(hits[0][covers(geometries[hits[1]], np.array(points, dtype=object)[hits[0]])].tolist())
        missing.extend([list(p.coords)[0] for i, p in enumerate(points) if i not in covered])
        checked += len(points)
    report = {'checked': checked, 'missing': len(missing), 'examples': missing[:10]}
    print(json.dumps(report))
    assert not missing, 'Artificial gaps on interior vegetation chunk cuts'


if __name__ == '__main__':
    audit()
