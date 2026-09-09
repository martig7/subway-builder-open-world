"""Offline, resumable route geometry archives for native and cross-tile views.

An index entry is a 128-bit SHA256 prefix, uint64 offset, uint32 gzip length,
and a reserved uint32. The server searches the index on disk and reads one
independently compressed JSON record. No road graph is shipped to the viewer.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import http.client
import json
from pathlib import Path
import re
import sqlite3
import struct
import threading
import time
from urllib.parse import urlsplit, quote

VERSION = 'stored-driving-routes-v1'
HEADER = struct.Struct('<8sII')
ENTRY = struct.Struct('<16sQII')
MAGIC = b'OWRTIDX1'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read_json(path):
    raw = Path(path).read_bytes()
    return json.loads(gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw)


def demand_routes(data, cross=False):
    if cross:
        fields = {key: i for i, key in enumerate(data['popFields'])}
        for pop in data['pops']:
            home = data['points'][pop[fields['homePoint']]]
            work = data['points'][pop[fields['workPoint']]]
            yield str(pop[fields['id']]), home[1:3], work[1:3]
    else:
        points = {p['id']: p['location'] for p in data['points']}
        for pop in data['pops']:
            yield str(pop['id']), points[pop['residenceId']], points[pop['jobId']]


def route_key(origin, destination, dataset):
    return hashlib.sha256(json.dumps([dataset, origin, destination], separators=(',', ':')).encode()).hexdigest()


class OsrmGeometry:
    def __init__(self, base_url):
        self.url = urlsplit(base_url)
        if self.url.scheme not in ('http', 'https'):
            raise ValueError('OSRM requires an HTTP(S) URL')
        self.local = threading.local()

    def __call__(self, endpoints):
        origin, destination = endpoints
        coordinates = ';'.join(','.join(format(float(v), '.7f') for v in point) for point in endpoints)
        path = f'{self.url.path}/route/v1/driving/{quote(coordinates, safe=",;.")}?overview=full&geometries=polyline6&steps=false'
        for attempt in range(3):
            try:
                connection = getattr(self.local, 'connection', None)
                if connection is None:
                    cls = http.client.HTTPSConnection if self.url.scheme == 'https' else http.client.HTTPConnection
                    connection = cls(self.url.hostname, self.url.port, timeout=45)
                    self.local.connection = connection
                connection.request('GET', path)
                response = connection.getresponse()
                raw = response.read()
                result = json.loads(raw)
                if result.get('code') in ('NoRoute', 'NoSegment'):
                    return dict(origin=origin, destination=destination, polyline=None,
                                source='geometric-no-road-route', reason=result['code'])
                if response.status != 200:
                    raise RuntimeError(f'OSRM HTTP {response.status}: {result.get("code")}')
                if result.get('code') != 'Ok' or not result.get('routes'):
                    raise ValueError(f'Unexpected OSRM result: {result.get("code")}')
                route = result['routes'][0]
                if not isinstance(route.get('geometry'), str) or not route['geometry']:
                    raise ValueError('Missing route geometry')
                return dict(origin=origin, destination=destination, polyline=route['geometry'],
                            source='stored-osrm', metres=route['distance'], seconds=route['duration'])
            except (OSError, http.client.HTTPException, RuntimeError):
                if getattr(self.local, 'connection', None):
                    self.local.connection.close()
                self.local.connection = None
                if attempt == 2:
                    raise
                time.sleep(.25 * (attempt + 1))


def write_archive(directory, stem, records):
    directory.mkdir(parents=True, exist_ok=True)
    entries, hashes, payloads = [], set(), {}
    counts = Counter()
    data_path = directory / f'{stem}.bin'
    index_path = directory / f'{stem}.idx'
    with data_path.with_suffix('.bin.pending').open('wb') as stream:
        for pop_id, record in records:
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', pop_id):
                raise ValueError('Unsupported route pop id')
            key = hashlib.sha256(pop_id.encode()).digest()[:16]
            if key in hashes:
                raise ValueError('Duplicate pop id or route index hash collision')
            hashes.add(key)
            raw = json.dumps(record, separators=(',', ':'), ensure_ascii=True).encode()
            payload_key = hashlib.sha256(raw).digest()
            if payload_key not in payloads:
                zipped = gzip.compress(raw, compresslevel=6, mtime=0)
                if len(zipped) > 2 * 1024 * 1024:
                    raise ValueError('Route exceeds the bounded record size')
                payloads[payload_key] = (stream.tell(), len(zipped))
                stream.write(zipped)
            offset, length = payloads[payload_key]
            entries.append((key, offset, length, 0))
            counts[record['source']] += 1
    with index_path.with_suffix('.idx.pending').open('wb') as stream:
        stream.write(HEADER.pack(MAGIC, 1, len(entries)))
        for entry in sorted(entries):
            stream.write(ENTRY.pack(*entry))
    # Verify every index pointer against the data before publishing the pair.
    data_size = data_path.with_suffix('.bin.pending').stat().st_size
    if any(offset + length > data_size for _, offset, length, _ in entries):
        raise ValueError('Invalid route record offset')
    data_path.with_suffix('.bin.pending').replace(data_path)
    index_path.with_suffix('.idx.pending').replace(index_path)
    return dict(routes=len(entries), uniqueRecords=len(payloads), sources=dict(counts),
                assets=[dict(path=p.name, bytes=p.stat().st_size, sha256=digest(p)) for p in [index_path, data_path]])


def build(demand_root, output_root, dataset, base_url, workers=16):
    output_root.mkdir(parents=True, exist_ok=True)
    cache = sqlite3.connect(output_root / 'geometry-cache.sqlite3')
    cache.execute('CREATE TABLE IF NOT EXISTS geometry (key TEXT PRIMARY KEY, payload BLOB NOT NULL)')
    router = OsrmGeometry(base_url)
    sources = [('cross', demand_root / 'world/cross_demand.json.gz', 'cross-driving-routes')]
    sources += [(p.parent.name, p, 'driving-routes') for p in sorted((demand_root / 'tiles').glob('*/demand_data.json.gz'))]
    summary = dict(version=VERSION, datasetId=dataset, packages={})
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for tile, source, stem in sources:
            started = time.monotonic()
            output = output_root / tile
            manifest_path = output / 'route-manifest.json'
            pin = dict(version=VERSION, datasetId=dataset, demandSha256=digest(source), tileId=tile)
            if manifest_path.exists():
                previous = json.loads(manifest_path.read_text())
                if all(previous.get(k) == v for k, v in pin.items()) and all(digest(output / a['path']) == a['sha256'] for a in previous['assets']):
                    summary['packages'][tile] = previous
                    print(json.dumps(dict(stage='resumed', tile=tile, routes=previous['routes'])), flush=True)
                    continue
            rows = list(demand_routes(read_json(source), cross=tile == 'cross'))
            records = []
            for start in range(0, len(rows), 256):
                batch = rows[start:start + 256]
                keys = [route_key(o, d, dataset) for _, o, d in batch]
                found = {key: payload for key, payload in cache.execute('SELECT key,payload FROM geometry WHERE key IN (' + ','.join('?' for _ in keys) + ')', keys)}
                missing = {key: (o, d) for key, (_, o, d) in zip(keys, batch) if key not in found}
                for key, result in zip(missing, pool.map(router, missing.values())):
                    payload = gzip.compress(json.dumps(result, separators=(',', ':')).encode(), mtime=0)
                    cache.execute('INSERT OR REPLACE INTO geometry VALUES (?,?)', (key, payload))
                    found[key] = payload
                cache.commit()
                records.extend((row[0], json.loads(gzip.decompress(found[key]))) for key, row in zip(keys, batch))
                if start % 4096 == 0:
                    print(json.dumps(dict(stage='routes', tile=tile, completed=min(start + 256, len(rows)), total=len(rows))), flush=True)
            report = {**pin, **write_archive(output, stem, records), 'seconds': time.monotonic() - started}
            manifest_path.write_text(json.dumps(report, indent=2) + '\n')
            summary['packages'][tile] = report
            print(json.dumps(dict(stage='complete', **report)), flush=True)
            del records, rows
    cache.close()
    (output_root / 'route-geometry-manifest.json').write_text(json.dumps(summary, indent=2) + '\n')
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--demand-root', type=Path, required=True)
    parser.add_argument('--output-root', type=Path, required=True)
    parser.add_argument('--dataset-id', required=True)
    parser.add_argument('--osrm-base-url', default='http://127.0.0.1:5000')
    parser.add_argument('--workers', type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.workers <= 64:
        parser.error('workers must be between 1 and 64')
    build(args.demand_root, args.output_root, args.dataset_id, args.osrm_base_url, args.workers)


if __name__ == '__main__':
    main()
