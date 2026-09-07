"""Repair generated METR path lengths using the native geodesic distance model.

Writes a separate file. Existing ridership/finance totals are retained. Live train
positions and compressed commute state are cleared so the scheduler can rebuild
them against the changed geometry. This deliberately interrupts in-flight trips.
"""
import argparse
import json
from pathlib import Path
import runpy
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if output.exists():
        raise FileExistsError(output)
    codec = runpy.run_path(str(Path(__file__).with_name('build-japan-stress-save.py')))
    blob, container = codec['decode'](args.input)
    save = container['mainSave']
    data = save['data']
    tracks = {track['id']: track for track in data['tracks']}
    for track in tracks.values():
        track['length'] = sum(codec['distance'](a, b) for a, b in zip(track['coords'], track['coords'][1:]))
        if track.get('curveGeometry'):
            track['curveGeometry']['length'] = track['length']

    def refresh(value):
        if isinstance(value, list):
            for item in value:
                refresh(item)
        elif isinstance(value, dict):
            if 'trackId' in value and 'length' in value:
                value['length'] = tracks[value['trackId']]['length']
            for item in value.values():
                refresh(item)
            if 'path' in value and 'distance' in value:
                value['distance'] = sum(step['length'] for step in value['path'])

    refresh(data['routes'])
    data['trains'] = []
    data['timeConfig']['paused'] = True
    for signal in data['signals']:
        signal['status'] = {'occupations': [], 'reservedBy': None}
    data['compressedDemandData'] = {'v': 2, 'p': [], 'd': [], 'c': []}
    save.update(id=str(uuid.uuid4()), name=args.name, timestamp=int(time.time() * 1000))
    save['metadata']['trains'] = 0
    output.write_bytes(codec['encode'](blob, save))
    assert codec['decode'](output)[1]['mainSave'] == save
    print(json.dumps({'output': str(output), 'metadata': save['metadata'], 'ridership': data['totalLifetimeRidership']}))


if __name__ == '__main__':
    main()
