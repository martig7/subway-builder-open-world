"""Prepare a physical land mask from OSM coast polygons minus PBF inland water."""
import argparse
import hashlib
import json
import time
from pathlib import Path

import shapely
from shapely.geometry import box, shape, mapping, Polygon


def repair_area_rings(area):
    def coordinates(ring):
        return [(node.location.lon, node.location.lat) for node in ring]
    polygons = []
    for outer in area.outer_rings():
        shell = coordinates(outer)
        holes = [coordinates(inner) for inner in area.inner_rings(outer)]
        if len(shell) >= 4:
            polygons.append(shapely.make_valid(Polygon(shell, [h for h in holes if len(h) >= 4])))
    return shapely.union_all(polygons)


def prepare(coast_zip, pbf, output, bounds, progress=print):
    import shapefile
    import osmium
    from shapely import wkb

    region = box(*bounds)
    progress("[water-mask] reading unsimplified OSM coast polygons")
    reader = shapefile.Reader(str(coast_zip))
    pieces = [shapely.make_valid(shape(record.__geo_interface__)).intersection(region)
              for record in reader.iterShapes(bbox=bounds)]
    reader.close()
    land = shapely.union_all(pieces)
    factory = osmium.geom.WKBFactory()
    waters = []
    repaired, unusable = [], []

    class WaterAreas(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.count, self.last = 0, time.monotonic()

        def area(self, area):
            self.count += 1
            if time.monotonic() - self.last > 20:
                progress(f"[water-mask] inspected {self.count} areas; {len(waters)} inland waters")
                self.last = time.monotonic()
            tags = area.tags
            if not (tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
                    or tags.get("landuse") in {"reservoir", "basin"}):
                return
            try:
                geometry = shapely.make_valid(wkb.loads(factory.create_multipolygon(area), hex=True))
            except RuntimeError:
                geometry = repair_area_rings(area)
                repaired.append(int(area.id))
            if geometry.is_empty:
                unusable.append(int(area.id))
                return
            if geometry.intersects(region):
                waters.append(geometry.intersection(region))

    handler = WaterAreas()
    progress("[water-mask] assembling full-detail inland water from OSM PBF")
    handler.apply_file(str(pbf), locations=True, idx="sparse_mem_array")
    progress(f"[water-mask] subtracting {len(waters)} inland water areas")
    land = shapely.make_valid(land.difference(shapely.union_all(waters)))
    polygons = [p for p in shapely.get_parts(land) if p.geom_type == "Polygon" and not p.is_empty]
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"type": "FeatureCollection", "purpose": "physical-land-computation", "coverageBounds": bounds,
              "source": "OpenStreetMap contributors / ODbL; osmdata.openstreetmap.de coast plus OSRM-source PBF inland water",
              "features": [{"type": "Feature", "properties": {"landPart": i}, "geometry": mapping(p)}
                           for i, p in enumerate(polygons)]}
    output.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
    hashes = {}
    for name, path in (("coast", coast_zip), ("pbf", pbf), ("output", output)):
        with path.open("rb") as stream:
            hashes[name] = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {"status": "complete", "polygons": len(polygons), "inlandWaters": len(waters),
              "vertices": int(shapely.get_num_coordinates(land)), "sha256": hashes, "bounds": bounds,
              "repairedAreaIds": repaired, "unusableAreaIds": unusable}
    output.with_suffix(".report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    progress(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coast-zip", type=Path, required=True)
    parser.add_argument("--pbf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bounds", type=float, nargs=4, required=True)
    args = parser.parse_args()
    prepare(args.coast_zip, args.pbf, args.output, args.bounds, lambda message: print(message, flush=True))
