"""Build independently loadable Depot packages for the NY corridor canary."""

from __future__ import annotations

import gzip
import json
import os
import resource
import shutil
import time
from pathlib import Path

from depot.maps import MapGen
from pyproj import Transformer


ROOT = Path("/work")
CATALOG = ROOT / "generated" / "catalog" / "tile-catalog.json"
INVENTORY = ROOT / "generated" / "reports" / "lodes-tile-inventory.json"
RAW_OSM = ROOT / "raw-data" / "osm"
OUTPUT = ROOT / "generated" / "pilot"
DEPOT_OUTPUT = OUTPUT / "depot"
PLANETILER_WORK = Path("/planetiler-data")
OSM_SOURCES = (
    "new-york-260810.osm.pbf",
    "new-jersey-260810.osm.pbf",
    "pennsylvania-260810.osm.pbf",
    "connecticut-260810.osm.pbf",
    "massachusetts-260810.osm.pbf",
    "vermont-260810.osm.pbf",
)
SHARED_OSM = RAW_OSM / "northeast-260810-merged.osm.pbf"
DEPOT_CODES = {
    "NY_CP00_RP00": "NYA0",
    "NY_CP00_RP01": "NYA1",
    "NY_CP01_RP00": "NYA2",
    "NY_CM01_RP01": "NYA3",
    "NY_CM01_RP02": "NYA4",
    "NY_CM01_RP03": "NYA5",
    "NY_CP00_RP02": "NYA6",
}


def _gzip_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, destination.open("wb") as raw_output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_output, mtime=0) as output:
            shutil.copyfileobj(input_file, output)


def _halo_bounds(tile: dict) -> list[float]:
    inverse = Transformer.from_crs("EPSG:26918", "EPSG:4326", always_xy=True)
    min_x, min_y, max_x, max_y = tile["haloProjected"]
    corners = [inverse.transform(x, y) for x, y in ((min_x, min_y), (min_x, max_y), (max_x, min_y), (max_x, max_y))]
    return [min(point[0] for point in corners), min(point[1] for point in corners), max(point[0] for point in corners), max(point[1] for point in corners)]


def _count_features(path: Path) -> int | None:
    if not path.is_file():
        return None
    markers = (b'"type":"Feature"', b'"type": "Feature"')
    count = 0
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            count += sum(chunk.count(marker) for marker in markers)
    return count


def _publish(tile_id: str, depot_code: str, city_dir: Path) -> dict[str, int]:
    tile_dir = OUTPUT / "tiles" / tile_id
    tile_dir.mkdir(parents=True, exist_ok=True)
    required = {
        "buildings_index.bin.gz": city_dir / "buildings_index.bin.gz",
        "roads.geojson.gz": city_dir / "roads.geojson",
        "runways_taxiways.geojson.gz": city_dir / "runways_taxiways.geojson",
        "tiles.pmtiles": city_dir / f"{depot_code}.pmtiles",
    }
    missing = [str(path) for path in required.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Depot did not produce required assets: {missing}")
    shutil.copyfile(required["buildings_index.bin.gz"], tile_dir / "buildings_index.bin.gz")
    _gzip_copy(required["roads.geojson.gz"], tile_dir / "roads.geojson.gz")
    _gzip_copy(required["runways_taxiways.geojson.gz"], tile_dir / "runways_taxiways.geojson.gz")
    shutil.copyfile(required["tiles.pmtiles"], tile_dir / "tiles.pmtiles")
    return {name: (tile_dir / name).stat().st_size for name in required}


def _build(tile: dict) -> dict:
    tile_id = tile["id"]
    depot_code = DEPOT_CODES[tile_id]
    DEPOT_OUTPUT.mkdir(parents=True, exist_ok=True)
    marker = OUTPUT / "benchmarks" / f"{tile_id}.json"
    if marker.is_file():
        return json.loads(marker.read_text(encoding="utf-8"))
    started = time.perf_counter()
    bbox = _halo_bounds(tile)
    osm_sources = [SHARED_OSM] if SHARED_OSM.is_file() else [RAW_OSM / name for name in OSM_SOURCES]
    generator = MapGen(
        city=depot_code,
        bbox=bbox,
        osmpbf=[str(path) for path in osm_sources],
        outputdir=str(DEPOT_OUTPUT),
        building_index_filter_size=50,
        building_tile_filter_size=50,
        building_index_simplification=1.5,
        building_tile_simplification=1,
        max_building_tile_size=450,
        cities=["city", "borough", "town"],
        suburbs=["suburb", "village"],
        neighborhoods=["neighbourhood", "hamlet", "quarter", "locality"],
        create_building_foundations=False,
        create_ocean_foundations=False,
        maxzoom=15,
        ncores=8,
        RAM=12,
        cleanup_files=True,
        verb=True,
    )
    city_dir = DEPOT_OUTPUT / depot_code
    stages = []
    for name, outputs, action in (
        ("base", [city_dir / f"{depot_code.lower()}-nobuildings.geojson"], generator.extract_base_data),
        ("buildings", [city_dir / "buildings_index.bin.gz"], generator.process_buildings),
        ("roads", [city_dir / "roads.geojson", city_dir / "runways_taxiways.geojson"], generator.process_roads_and_aeroways),
        ("pmtiles", [city_dir / f"{depot_code}-nolabels.pmtiles"], generator.generate_pmtiles),
        ("labels", [city_dir / f"{depot_code}.pmtiles"], generator.add_labels),
    ):
        stage_started = time.perf_counter()
        skipped = all(path.is_file() for path in outputs)
        if not skipped:
            action()
        stages.append({"name": name, "seconds": round(time.perf_counter() - stage_started, 3), "resumed": skipped})
    building_features = _count_features(city_dir / "buildings_cleaned.json")
    road_features = _count_features(city_dir / "roads.geojson")
    asset_bytes = _publish(tile_id, depot_code, city_dir)
    report = {
        "schemaVersion": 1,
        "tileId": tile_id,
        "depotCode": depot_code,
        "bbox": bbox,
        "stateIntersectionKm2": tile["stateIntersectionKm2"],
        "buildingFeatures": building_features,
        "roadFeatures": road_features,
        "assetBytes": asset_bytes,
        "installedBytes": sum(asset_bytes.values()),
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
        "stages": stages,
    }
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if os.environ.get("NY_KEEP_DEPOT_WORK") != "1":
        resolved_city = city_dir.resolve()
        if resolved_city.parent != DEPOT_OUTPUT.resolve():
            raise RuntimeError(f"refusing to clean unexpected Depot path: {resolved_city}")
        shutil.rmtree(resolved_city)
    return report


def main() -> None:
    PLANETILER_WORK.mkdir(parents=True, exist_ok=True)
    os.chdir(PLANETILER_WORK)
    missing = [] if SHARED_OSM.is_file() else [str(RAW_OSM / name) for name in OSM_SOURCES if not (RAW_OSM / name).is_file()]
    if missing:
        raise FileNotFoundError(f"missing pinned regional OSM inputs: {missing}")
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    pilot_ids = list(DEPOT_CODES)
    requested = {value for value in os.environ.get("NY_PILOT_TILE_IDS", "").split(",") if value}
    if requested:
        unknown = requested - set(pilot_ids)
        if unknown:
            raise ValueError(f"requested non-pilot tile IDs: {sorted(unknown)}")
        pilot_ids = [tile_id for tile_id in pilot_ids if tile_id in requested]
    by_id = {tile["id"]: tile for tile in catalog["tiles"]}
    results = [_build(by_id[tile_id]) for tile_id in pilot_ids]
    summary = {
        "schemaVersion": 1,
        "prototype": True,
        "tiles": results,
        "installedBytes": sum(row["installedBytes"] for row in results),
        "elapsedSeconds": round(sum(row["elapsedSeconds"] for row in results), 3),
        "peakRssBytes": max(row["peakRssBytes"] for row in results),
    }
    target = OUTPUT / "reports" / "pilot-depot.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"valid": True, "tiles": len(results), "installedBytes": summary["installedBytes"]}, sort_keys=True))


if __name__ == "__main__":
    main()
