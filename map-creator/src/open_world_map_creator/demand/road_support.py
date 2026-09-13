"""Read cached OSM inputs for demand support without building or fetching tiles."""
import gzip
import hashlib
import json
from collections import Counter, OrderedDict
from pathlib import Path

import osmium
import shapely
from shapely.geometry import LineString

from .frontage_allocation import road_weights

VERSION = 'osm-frontage-support-v1'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    with gzip.open(path, 'rt', encoding='utf-8') as stream:
        return json.load(stream)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + '.pending')
    with pending.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as stream:
        stream.write(json.dumps(value, separators=(',', ':'), sort_keys=True).encode())
    pending.replace(path)


class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.factory = osmium.geom.WKBFactory()
        self.roads = []
        self.areas = []
        self.counts = Counter()

    def way(self, way):
        tags = {key: way.tags.get(key, '') for key in ('highway', 'bridge', 'tunnel', 'service', 'access')}
        weights = road_weights(tags)
        if weights is None:
            return
        try:
            coordinates = [(node.lon, node.lat) for node in way.nodes]
            if len(coordinates) < 2:
                return
            self.roads.append(dict(id=f'osm-road-{way.id}', coordinates=coordinates,
                                   weights=weights, highway=tags['highway']))
            self.counts[tags['highway']] += 1
        except (osmium.InvalidLocationError, ValueError):
            self.counts['invalid-road'] += 1

    def area(self, area):
        natural, landuse = area.tags.get('natural', ''), area.tags.get('landuse', '')
        water = natural in ('water', 'wetland') or landuse in ('reservoir', 'basin') or bool(area.tags.get('water'))
        excluded = water or landuse in ('cemetery', 'landfill', 'quarry', 'railway')
        kind = landuse if landuse in ('residential', 'commercial', 'retail', 'industrial', 'forest', 'farmland', 'meadow') else None
        if not excluded and not kind:
            return
        try:
            geometry = shapely.make_valid(shapely.from_wkb(self.factory.create_multipolygon(area)))
            self.areas.append(dict(id=str(area.id), kind='excluded' if excluded else kind,
                                   geometry=shapely.to_geojson(geometry)))
        except (RuntimeError, ValueError, shapely.GEOSException):
            self.counts['invalid-area'] += 1


class RoadSupportCache:
    def __init__(self, map_config, osm_root, cache_root, progress=print):
        self.config = map_config
        self.osm_root = Path(osm_root)
        self.root = Path(cache_root)
        self.progress = progress
        self.pins = {}
        self.loaded = OrderedDict()

    def prepare(self):
        for name, source in sorted(self.config['sources'].items()):
            path = self.osm_root / source['filename']
            # Deliberately no download branch: missing local evidence fails.
            if not path.is_file():
                raise FileNotFoundError(f'Cached OSM input required: {path}')
            pin = dict(version=VERSION, inputSha256=digest(path), codeSha256=digest(Path(__file__)))
            target = self.root / f'{name}.json.gz'
            stamp = self.root / f'{name}.manifest.json'
            self.pins[name] = pin
            try:
                previous = json.loads(stamp.read_text())
                if previous['input'] == pin and digest(target) == previous['outputSha256']:
                    self.progress(f'[road-support] reused {name}')
                    continue
            except (OSError, ValueError, KeyError):
                pass
            self.progress(f'[road-support] extracting cached {name}')
            handler = Extract()
            handler.apply_file(str(path), locations=True, idx='flex_mem')
            write(target, dict(roads=handler.roads, areas=handler.areas, counts=dict(handler.counts)))
            stamp.write_text(json.dumps(dict(input=pin, outputSha256=digest(target)), sort_keys=True))
            self.progress(f'[road-support] ready {name}: {len(handler.roads)} frontage roads')
            del handler

    def _load(self, name):
        if name in self.loaded:
            self.loaded.move_to_end(name)
            return self.loaded[name]
        value = read(self.root / f'{name}.json.gz')
        roads = [LineString(row['coordinates']) for row in value['roads']]
        areas = [shapely.from_geojson(row['geometry']) for row in value['areas']]
        value['roadTree'] = shapely.STRtree(roads)
        value['areaTree'] = shapely.STRtree(areas)
        self.loaded[name] = value
        while len(self.loaded) > 2:
            self.loaded.popitem(last=False)
        return value

    def owner_data(self, owner, boundary):
        box = shapely.box(*boundary.bounds).buffer(.01)
        roads, areas = {}, {}
        for name in self.config['prefectureSources'][owner]:
            value = self._load(name)
            for index in value['roadTree'].query(box):
                row = value['roads'][int(index)]
                previous = roads.get(row['id'])
                if previous is None or len(row['coordinates']) > len(previous['coordinates']):
                    roads[row['id']] = row
            for index in value['areaTree'].query(box):
                row = value['areas'][int(index)]
                previous = areas.get(row['id'])
                if previous is None or len(row['geometry']) > len(previous['geometry']):
                    areas[row['id']] = row
        return dict(roads=[roads[key] for key in sorted(roads)],
                    masks=[row['geometry'] for key,row in sorted(areas.items()) if row['kind']=='excluded'],
                    landuse=[(row['kind'],row['geometry']) for key,row in sorted(areas.items()) if row['kind']!='excluded'])

    def owner_pin(self, owner):
        return {name:self.pins[name] for name in self.config['prefectureSources'][owner]}
