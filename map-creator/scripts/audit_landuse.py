"""Read-only inventory of installed/archive land-use categories.

Counts are vector-tile occurrences, not unique parks (zoom levels and tiles
repeat features). Every tile is read, independently of metadata summaries.
No package, demand, or routing data is modified.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import gzip
import json
import mmap
from pathlib import Path
import time

from mapbox_vector_tile.Mapbox import vector_tile_pb2
from pmtiles.reader import Reader, all_tiles


def inventory(path):
    started = time.monotonic()
    with path.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
        read = lambda offset, length: mapped[offset:offset + length]
        reader = Reader(read)
        metadata = reader.metadata()
        layers = {layer['id']: layer for layer in metadata.get('vector_layers', [])}
        counts = Counter()
        tiles = 0
        for zxy, data in all_tiles(read):
            tiles += 1
            raw = gzip.decompress(data) if data[:2] == b'\x1f\x8b' else data
            if b'landuse' not in raw and b'parks' not in raw:
                continue
            tile = vector_tile_pb2.tile()
            tile.ParseFromString(raw)
            for layer in tile.layers:
                if layer.name not in {'landuse', 'parks'}:
                    continue
                for feature in layer.features:
                    props = {layer.keys[k]: layer.values[v].string_value
                             for k, v in zip(feature.tags[::2], feature.tags[1::2])}
                    counts[f'{layer.name}:{props.get("kind", "<missing>")}'] += 1
        return {'archive': str(path), 'tileId': path.parent.name, 'tilesRead': tiles,
                'layers': layers, 'categoryOccurrences': dict(sorted(counts.items())),
                'seconds': round(time.monotonic() - started, 2)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--prefix', action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    paths = sorted(path for path in args.root.glob('*/tiles.pmtiles')
                   if any(path.parent.name.startswith(prefix) for prefix in args.prefix))
    if not paths:
        raise ValueError('No matching tile archives')
    reports = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {pool.submit(inventory, path): path for path in paths}
        for future in as_completed(pending):
            report = future.result()
            reports.append(report)
            print(json.dumps({'stage': 'landuse-inventory', 'done': len(reports), 'total': len(paths),
                              **{k: v for k, v in report.items() if k not in {'layers', 'archive'}}}), flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'archives': sorted(reports, key=lambda r: r['tileId'])}, indent=2) + '\n')


if __name__ == '__main__':
    main()
