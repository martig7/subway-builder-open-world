"""Generate the one corridor-wide Depot archive used by KCW and KCE."""

from __future__ import annotations

import gzip
import os
import shutil
from pathlib import Path

from depot.maps import MapGen


ROOT = Path("/work")
RAW_OSM = ROOT / "raw-data" / "osm"
OUTPUT = ROOT / "artifacts" / "depot"
PLANETILER_WORK = Path("/planetiler-data")
CITY = "KCOW"

# The union of both 25 km ownership tiles plus their 2 km immutable-data halos,
# transformed from the prototype's EPSG:26915 bounds to WGS84.
BBOX = [-94.9151347, 38.8646530, -94.2976758, 39.1344634]


def gzip_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, destination.open("wb") as raw_output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw_output, mtime=0) as output:
            shutil.copyfileobj(input_file, output)


def publish_runtime_assets(city_dir: Path) -> None:
    required = {
        "buildings_index.bin.gz": city_dir / "buildings_index.bin.gz",
        "roads.geojson.gz": city_dir / "roads.geojson",
        "runways_taxiways.geojson.gz": city_dir / "runways_taxiways.geojson",
    }
    archive = city_dir / f"{CITY}.pmtiles"
    missing = [str(path) for path in [archive, *required.values()] if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Depot did not produce required assets: {missing}")

    # The game requires city-specific data-file URLs. Both logical ownership
    # tiles use the corridor-wide collision/road data and the same PMTiles.
    for tile_id in ("KCW", "KCE"):
        tile_dir = ROOT / "artifacts" / tile_id
        tile_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(required["buildings_index.bin.gz"], tile_dir / "buildings_index.bin.gz")
        gzip_copy(required["roads.geojson.gz"], tile_dir / "roads.geojson.gz")
        gzip_copy(required["runways_taxiways.geojson.gz"], tile_dir / "runways_taxiways.geojson.gz")


def prepare_planetiler_workdir() -> None:
    """Keep merge-sort temp files on Linux storage, not the Windows bind mount."""
    PLANETILER_WORK.mkdir(parents=True, exist_ok=True)
    legacy_cache = ROOT / "data"
    target_cache = PLANETILER_WORK / "data"
    if legacy_cache.is_dir() and not target_cache.exists():
        # Seed the named volume from a partial/earlier run instead of fetching
        # Planetiler's ~1.45 GB support data again.
        shutil.copytree(legacy_cache, target_cache)
    os.chdir(PLANETILER_WORK)


def main() -> None:
    prepare_planetiler_workdir()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    sources = [
        RAW_OSM / "kansas-latest.osm.pbf",
        RAW_OSM / "missouri-latest.osm.pbf",
    ]
    missing = [str(path) for path in sources if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Download the pinned regional OSM inputs first: {missing}")

    generator = MapGen(
        city=CITY,
        bbox=BBOX,
        osmpbf=[str(path) for path in sources],
        outputdir=str(OUTPUT),
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
    city_dir = OUTPUT / CITY
    if not (city_dir / f"{CITY.lower()}-nobuildings.geojson").is_file():
        generator.extract_base_data()
    if not (city_dir / "buildings_index.bin.gz").is_file():
        generator.process_buildings()
    if not all((city_dir / name).is_file() for name in ("roads.geojson", "runways_taxiways.geojson")):
        generator.process_roads_and_aeroways()
    if not (city_dir / f"{CITY}-nolabels.pmtiles").is_file():
        generator.generate_pmtiles()
    if not (city_dir / f"{CITY}.pmtiles").is_file():
        generator.add_labels()
    publish_runtime_assets(city_dir)


if __name__ == "__main__":
    main()
