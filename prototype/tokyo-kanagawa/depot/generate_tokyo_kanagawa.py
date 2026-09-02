"""Build independently loadable mainland Tokyo and Kanagawa Depot packages."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import resource
import shutil
import time
from pathlib import Path

from depot.maps import MapGen
ROOT = Path("/work")
CATALOG = ROOT / "generated" / "catalog" / "tokyo-kanagawa-tile-catalog.json"
RAW_OSM = ROOT / "raw-data" / "osm"
OUTPUT = ROOT / "generated" / "maps"
DEPOT_OUTPUT = OUTPUT / "depot"
PLANETILER_WORK = Path("/planetiler-data")
OSM_SOURCES = {"KANTO": "kanto-latest.osm.pbf"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _gzip_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, destination.open("wb") as raw_output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_output, mtime=0) as output:
            shutil.copyfileobj(input_file, output)


def _halo_bounds(tile: dict) -> list[float]:
    return list(tile["haloBounds"])


def _count_features(path: Path) -> int | None:
    if not path.is_file():
        return None
    markers = (b'"type":"Feature"', b'"type": "Feature"')
    count = 0
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            count += sum(chunk.count(marker) for marker in markers)
    return count


def _depot_code(index: int) -> str:
    return f"JT{index:02d}"


def _publish(tile_id: str, depot_code: str, city_dir: Path, tile: dict) -> dict[str, int]:
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
    for name, source in required.items():
        destination = tile_dir / name
        if name.endswith(".geojson.gz"):
            _gzip_copy(source, destination)
        else:
            shutil.copyfile(source, destination)
    # Preserve the unmodified Depot archive as the high-zoom input for the
    # world-basemap splice. A regenerated tile must never reuse a stale copy.
    shutil.copyfile(required["tiles.pmtiles"], tile_dir / "tiles.city-only.pmtiles")
    manifest = {
        "schemaVersion": 1,
        "tileId": tile_id,
        "cityCode": depot_code,
        "haloBounds": _halo_bounds(tile),
        "assets": [{"path": name, "bytes": (tile_dir / name).stat().st_size, "sha256": _sha256(tile_dir / name)} for name in required],
    }
    (tile_dir / "map-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {name: (tile_dir / name).stat().st_size for name in required}


def _build(tile: dict, index: int, osm_sources: dict[str, Path], by_id: dict[str, dict]) -> dict:
    tile_id = tile["id"]
    depot_code = _depot_code(index)
    marker = OUTPUT / "benchmarks" / f"{tile_id}.json"
    if marker.is_file():
        return json.loads(marker.read_text(encoding="utf-8"))
    started = time.perf_counter()
    DEPOT_OUTPUT.mkdir(parents=True, exist_ok=True)
    bbox = _halo_bounds(tile)
    tile_sources = [osm_sources["KANTO"]]
    generator = MapGen(
        city=depot_code,
        bbox=bbox,
        osmpbf=[str(path) for path in tile_sources],
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
        # Tokyo's dense OSM building layer exceeds the NEC-sized 12 GB Node
        # heap. On a high-memory Runner, reserve a 48 GB
        # mapshaper heap while keeping room for the other Depot processes.
        RAM=48,
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
        resumed = all(path.is_file() for path in outputs)
        if not resumed:
            if name == "buildings":
                # Keep the map build fully OSM-backed. Depot's default Overture
                # catalog endpoint is external and can move independently of
                # the pinned OSM inputs, so derive building footprints from
                # the already extracted tile PBF instead.
                building_pbf = city_dir / f"{depot_code.lower()}-buildings.osm.pbf"
                building_geojson = city_dir / "buildings.geojson"
                generator._run_command([
                    "osmium", "tags-filter", str(generator.city_osmpbf),
                    "n/building=*", "w/building=*", "-o", str(building_pbf), "--overwrite",
                ])
                generator._run_command([
                    "ogr2ogr", "-f", "GeoJSON", str(building_geojson), str(building_pbf),
                    "multipolygons", "-where", "building IS NOT NULL",
                ])
                generator.buildings_geojson = str(building_geojson)
            action()
        stages.append({"name": name, "seconds": round(time.perf_counter() - stage_started, 3), "resumed": resumed})
    asset_bytes = _publish(tile_id, depot_code, city_dir, tile)
    report = {
        "schemaVersion": 1,
        "tileId": tile_id,
        "depotCode": depot_code,
        "bbox": bbox,
        "buildingFeatures": _count_features(city_dir / "buildings_cleaned.json"),
        "roadFeatures": _count_features(city_dir / "roads.geojson"),
        "assetBytes": asset_bytes,
        "installedBytes": sum(asset_bytes.values()),
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "peakRssBytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024),
        "stages": stages,
    }
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if os.environ.get("TOKYO_KANAGAWA_KEEP_DEPOT_WORK") != "1":
        resolved_city = city_dir.resolve()
        if resolved_city.parent != DEPOT_OUTPUT.resolve():
            raise RuntimeError(f"refusing to clean unexpected Depot path: {resolved_city}")
        shutil.rmtree(resolved_city)
    return report


def main() -> None:
    PLANETILER_WORK.mkdir(parents=True, exist_ok=True)
    os.chdir(PLANETILER_WORK)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    tiles = catalog["tiles"]
    by_id = {tile["id"]: tile for tile in tiles}
    requested = [value for value in os.environ.get("TOKYO_KANAGAWA_DEPOT_TILE_IDS", "").split(",") if value]
    tile_ids = requested or [tile["id"] for tile in tiles]
    unknown = sorted(set(tile_ids) - set(by_id))
    if unknown:
        raise ValueError(f"requested unknown tile IDs: {unknown}")
    sources = {postal: RAW_OSM / name for postal, name in OSM_SOURCES.items()}
    missing = [str(path) for path in sources.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"missing NEC OSM inputs: {missing}")
    global_index = {tile["id"]: index for index, tile in enumerate(tiles)}
    results = [_build(by_id[tile_id], global_index[tile_id], sources, by_id) for tile_id in tile_ids]
    summary = {"schemaVersion": 1, "prototype": True, "worldId": "JP_TOKYO_KANAGAWA_MAINLAND", "tiles": results, "installedBytes": sum(row["installedBytes"] for row in results), "elapsedSeconds": round(sum(row["elapsedSeconds"] for row in results), 3), "peakRssBytes": max(row["peakRssBytes"] for row in results)}
    target = OUTPUT / "reports" / "tokyo-kanagawa-depot.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"valid": True, "tiles": len(results), "installedBytes": summary["installedBytes"]}, sort_keys=True))


if __name__ == "__main__":
    main()
