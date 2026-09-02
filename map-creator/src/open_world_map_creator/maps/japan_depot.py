#!/usr/bin/env python3
"""Build resumable Depot map packages for Japan's catalogued Tile Views."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import resource
import shutil
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from depot.maps import MapGen


WORKER_VERSION = "japan-depot-prefecture-v1"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def gzip_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, destination.open("wb") as raw_output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_output, mtime=0) as output:
            shutil.copyfileobj(input_file, output)


class Progress:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.started = time.perf_counter()
        self.sequence = 0

    def emit(self, stage: str, status: str, **details: Any) -> None:
        self.sequence += 1
        event = {
            "event": "japan-map-progress",
            "workerVersion": WORKER_VERSION,
            "sequence": self.sequence,
            "stage": stage,
            "status": status,
            "elapsedSeconds": round(time.perf_counter() - self.started, 3),
            "capturedAt": datetime.now(UTC).isoformat(),
            **details,
        }
        line = json.dumps(event, ensure_ascii=False, sort_keys=True)
        print(json.dumps(event, ensure_ascii=True, sort_keys=True), flush=True)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8", newline="\n") as output:
            output.write(line + "\n")


def required_outputs(output_root: Path, tile_id: str) -> list[Path]:
    tile_root = output_root / "tiles" / tile_id
    return [tile_root / name for name in ("buildings_index.bin.gz", "roads.geojson.gz", "runways_taxiways.geojson.gz", "tiles.pmtiles", "map-manifest.json")]


def publish(output_root: Path, tile: dict[str, Any], depot_code: str, city_root: Path, source_names: list[str]) -> dict[str, Any]:
    tile_id = tile["id"]
    tile_root = output_root / "tiles" / tile_id
    tile_root.mkdir(parents=True, exist_ok=True)
    sources = {
        "buildings_index.bin.gz": city_root / "buildings_index.bin.gz",
        "roads.geojson.gz": city_root / "roads.geojson",
        "runways_taxiways.geojson.gz": city_root / "runways_taxiways.geojson",
        "tiles.pmtiles": city_root / f"{depot_code}.pmtiles",
    }
    missing = [str(path) for path in sources.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Depot did not produce required assets: {missing}")
    for name, source in sources.items():
        destination = tile_root / name
        gzip_copy(source, destination) if name.endswith(".geojson.gz") else shutil.copyfile(source, destination)
    shutil.copyfile(sources["tiles.pmtiles"], tile_root / "tiles.city-only.pmtiles")
    manifest = {
        "schemaVersion": 1,
        "workerVersion": WORKER_VERSION,
        "tileId": tile_id,
        "cityCode": depot_code,
        "prefCode": tile["prefCode"],
        "haloBounds": tile["haloBounds"],
        "osmSources": source_names,
        "assets": [{"path": name, "bytes": (tile_root / name).stat().st_size, "sha256": sha256(tile_root / name)} for name in sources],
    }
    (tile_root / "map-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def build_tile(*, tile: dict[str, Any], index: int, source_paths: list[Path], output_root: Path, planetiler_root: Path, progress: Progress, keep_work: bool) -> dict[str, Any]:
    tile_id = tile["id"]
    marker = output_root / "benchmarks" / f"{tile_id}.json"
    if marker.is_file() and all(path.is_file() and path.stat().st_size for path in required_outputs(output_root, tile_id)):
        result = read_json(marker)
        progress.emit("tile", "resumed", tileId=tile_id, prefCode=tile["prefCode"], installedBytes=result["installedBytes"])
        return result
    started = time.perf_counter()
    depot_code = f"JN{index + 1:02d}"
    depot_root = output_root / "depot"
    depot_root.mkdir(parents=True, exist_ok=True)
    planetiler_root.mkdir(parents=True, exist_ok=True)
    os.chdir(planetiler_root)
    generator = MapGen(
        city=depot_code,
        bbox=list(tile["haloBounds"]),
        osmpbf=[str(path) for path in source_paths],
        outputdir=str(depot_root),
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
        RAM=48,
        cleanup_files=True,
        verb=True,
    )
    city_root = depot_root / depot_code
    stage_reports = []
    progress.emit("tile", "started", tileId=tile_id, prefCode=tile["prefCode"], osmSources=[path.name for path in source_paths])
    for name, outputs, action in (
        ("base", [city_root / f"{depot_code.lower()}-nobuildings.geojson"], generator.extract_base_data),
        ("buildings", [city_root / "buildings_index.bin.gz"], generator.process_buildings),
        ("roads", [city_root / "roads.geojson", city_root / "runways_taxiways.geojson"], generator.process_roads_and_aeroways),
        ("pmtiles", [city_root / f"{depot_code}-nolabels.pmtiles"], generator.generate_pmtiles),
        ("labels", [city_root / f"{depot_code}.pmtiles"], generator.add_labels),
    ):
        stage_started = time.perf_counter()
        resumed = all(path.is_file() for path in outputs)
        progress.emit(name, "resumed" if resumed else "started", tileId=tile_id, prefCode=tile["prefCode"])
        if not resumed:
            if name == "buildings":
                building_pbf = city_root / f"{depot_code.lower()}-buildings.osm.pbf"
                building_geojson = city_root / "buildings.geojson"
                generator._run_command(["osmium", "tags-filter", str(generator.city_osmpbf), "n/building=*", "w/building=*", "-o", str(building_pbf), "--overwrite"])
                generator._run_command(["ogr2ogr", "-f", "GeoJSON", str(building_geojson), str(building_pbf), "multipolygons", "-where", "building IS NOT NULL"])
                generator.buildings_geojson = str(building_geojson)
            action()
        seconds = round(time.perf_counter() - stage_started, 3)
        stage_reports.append({"name": name, "seconds": seconds, "resumed": resumed})
        progress.emit(name, "complete", tileId=tile_id, prefCode=tile["prefCode"], seconds=seconds, resumed=resumed)
    manifest = publish(output_root, tile, depot_code, city_root, [path.name for path in source_paths])
    installed_bytes = sum(asset["bytes"] for asset in manifest["assets"])
    report = {
        "schemaVersion": 1,
        "workerVersion": WORKER_VERSION,
        "tileId": tile_id,
        "prefCode": tile["prefCode"],
        "depotCode": depot_code,
        "installedBytes": installed_bytes,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "peakRssBytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024),
        "stages": stage_reports,
    }
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    progress.emit("tile", "complete", tileId=tile_id, prefCode=tile["prefCode"], installedBytes=installed_bytes, seconds=report["elapsedSeconds"])
    if not keep_work:
        resolved = city_root.resolve()
        if resolved.parent != depot_root.resolve():
            raise RuntimeError(f"Refusing to clean unexpected Depot path: {resolved}")
        shutil.rmtree(resolved)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--map-config", type=Path, required=True)
    parser.add_argument("--osm-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--planetiler-root", type=Path, required=True)
    parser.add_argument("--progress-jsonl", type=Path, required=True)
    parser.add_argument("--tile", action="append", default=[])
    parser.add_argument("--keep-work", action="store_true")
    args = parser.parse_args()
    catalog = read_json(args.catalog)
    map_config = read_json(args.map_config)
    by_id = {tile["id"]: tile for tile in catalog["tiles"]}
    requested = args.tile or [tile["id"] for tile in catalog["tiles"]]
    unknown = sorted(set(requested) - set(by_id))
    if unknown:
        raise ValueError(f"Unknown Tile IDs: {unknown}")
    progress = Progress(args.progress_jsonl)
    reports = []
    for tile_id in requested:
        tile = by_id[tile_id]
        source_names = [map_config["sources"][name]["filename"] for name in map_config["prefectureSources"][tile["prefCode"]]]
        source_paths = [args.osm_root / name for name in source_names]
        missing = [str(path) for path in source_paths if not path.is_file()]
        if missing:
            raise FileNotFoundError(f"Missing OSM inputs for {tile_id}: {missing}")
        reports.append(build_tile(tile=tile, index=catalog["tiles"].index(tile), source_paths=source_paths, output_root=args.output_root, planetiler_root=args.planetiler_root, progress=progress, keep_work=args.keep_work))
    summary = {"schemaVersion": 1, "workerVersion": WORKER_VERSION, "tileCount": len(reports), "installedBytes": sum(report["installedBytes"] for report in reports), "tiles": reports}
    target = args.output_root / "reports" / "japan-depot.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    progress.emit("world", "complete", tileCount=len(reports), installedBytes=summary["installedBytes"])
    print(json.dumps({"valid": True, "tileCount": len(reports), "installedBytes": summary["installedBytes"]}, sort_keys=True))


if __name__ == "__main__":
    main()
