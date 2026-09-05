"""Physical land membership, independent of filled administrative ownership."""
import json
import hashlib
import numpy as np
import shapely
from shapely.geometry import shape


class PhysicalLandIndex:
    def __init__(self, source, *, validated=False):
        if source.get('purpose') != 'physical-land-computation':
            raise ValueError('Demand requires a physical-land mask, not ownership/display geometry')
        parts = [part for feature in source['features'] for part in shapely.get_parts(shape(feature['geometry']))]
        if not parts or any(p.is_empty or p.geom_type != 'Polygon' or (not validated and not p.is_valid) for p in parts):
            raise ValueError('Physical land must contain valid polygons')
        self.parts = np.asarray(parts, dtype=object)
        shapely.prepare(self.parts)
        self.tree = shapely.STRtree(self.parts)

    @classmethod
    def read(cls, path):
        payload = path.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        stamp = path.with_suffix(path.suffix + '.validation.json')
        signature = {'sha256':digest, 'geos':shapely.geos_version_string, 'validation':'all-polygons-is-valid-v1'}
        try:
            validated = json.loads(stamp.read_text(encoding='utf-8')) == signature
        except (OSError, ValueError):
            validated = False
        result = cls(json.loads(payload), validated=validated)
        if not validated:
            # This cache records a completed validation, never permission to
            # accept points off land. Any byte/GEOS change invalidates it.
            try:
                stamp.write_text(json.dumps(signature,sort_keys=True)+'\n',encoding='utf-8')
            except OSError:
                pass  # Read-only source stores remain supported.
        return result

    def covers(self, coordinates):
        coordinates = np.asarray(coordinates, dtype=float).reshape(-1, 2)
        result = np.zeros(len(coordinates), dtype=bool)
        if len(coordinates):
            points = shapely.points(coordinates)
            hits = self.tree.query(points)
            covered = shapely.covers(self.parts[hits[1]], points[hits[0]])
            result[hits[0][covered]] = True
        return result
