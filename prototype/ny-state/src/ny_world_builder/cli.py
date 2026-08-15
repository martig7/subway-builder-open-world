from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .acquire import acquire_sources
from .catalog import build_catalog
from .config import load_world_config
from .fixtures import build_runtime_fixtures
from .inventory import inventory_lodes
from .pilot_demand import compile_pilot_demand
from .pilot_benchmark import benchmark_pilot
from .pilot_routing import benchmark_routing


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "config" / "world-ny.yaml"
DEFAULT_LOCK = ROOT / "config" / "sources.lock.json"
DEFAULT_RAW = ROOT / "raw-data"
DEFAULT_GENERATED = ROOT / "generated"


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW))
    parser.add_argument("--generated-dir", default=str(DEFAULT_GENERATED))


def _catalog(config_path: str, raw_dir: str, generated_dir: str) -> dict:
    config = load_world_config(config_path)
    raw = Path(raw_dir)
    generated = Path(generated_dir)
    return build_catalog(
        config,
        raw / "cb_2024_us_state_500k.zip",
        generated / "catalog" / "tile-catalog.json",
        generated / "coverage" / "ny-tile-coverage.geojson",
        generated / "catalog" / "tile-catalog.generated.js",
        generated / "coverage" / "ny-tile-coverage.svg",
    )


def _inventory(config_path: str, raw_dir: str, generated_dir: str) -> dict:
    config = load_world_config(config_path)
    raw = Path(raw_dir)
    generated = Path(generated_dir)
    return inventory_lodes(
        config,
        generated / "catalog" / "tile-catalog.json",
        raw / "ny_xwalk.csv.gz",
        raw / "ny_od_main_JT01_2023.csv.gz",
        raw / "ny_od_aux_JT01_2023.csv.gz",
        generated / "reports" / "lodes-tile-inventory.json",
        generated / "reports" / "lodes-tile-inventory.md",
        generated / "reports" / "lodes-tile-pairs.csv",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ny-world-m0", description="PROTOTYPE New York State Milestone 0 compiler")
    commands = parser.add_subparsers(dest="command", required=True)
    acquire = commands.add_parser("acquire"); acquire.add_argument("--lock", default=str(DEFAULT_LOCK)); acquire.add_argument("--raw-dir", default=str(DEFAULT_RAW)); acquire.add_argument("--cache-dir")
    catalog = commands.add_parser("build-catalog"); _common(catalog)
    inventory = commands.add_parser("inventory-lodes"); _common(inventory)
    fixtures = commands.add_parser("build-runtime-fixtures"); fixtures.add_argument("--generated-dir", default=str(DEFAULT_GENERATED))
    pilot_demand = commands.add_parser("build-pilot-demand"); _common(pilot_demand); pilot_demand.add_argument("--work-database"); pilot_demand.add_argument("--tile", action="append", dest="tiles")
    pilot_routing = commands.add_parser("benchmark-pilot-routing"); pilot_routing.add_argument("--generated-dir", default=str(DEFAULT_GENERATED)); pilot_routing.add_argument("--samples-per-tile", type=int, default=5)
    pilot_benchmark = commands.add_parser("benchmark-pilot"); pilot_benchmark.add_argument("--generated-dir", default=str(DEFAULT_GENERATED))
    all_command = commands.add_parser("milestone0"); _common(all_command); all_command.add_argument("--lock", default=str(DEFAULT_LOCK)); all_command.add_argument("--cache-dir")
    args = parser.parse_args(argv)

    if args.command == "acquire":
        result = acquire_sources(args.lock, args.raw_dir, cache_dir=args.cache_dir)
    elif args.command == "build-catalog":
        catalog_result = _catalog(args.config, args.raw_dir, args.generated_dir)
        result = {
            "valid": True,
            "addressableTiles": catalog_result["selection"]["addressableCount"],
            "normalTiles": catalog_result["selection"]["normalCount"],
            "sliverTiles": catalog_result["selection"]["sliverCount"],
        }
    elif args.command == "inventory-lodes":
        inventory_result = _inventory(args.config, args.raw_dir, args.generated_dir)
        result = {
            "valid": True,
            "odRows": inventory_result["totals"]["odRows"],
            "workers": inventory_result["totals"]["workers"],
            "classificationWorkerDelta": inventory_result["totals"]["classificationWorkerDelta"],
            "tilePairCount": inventory_result["tilePairCount"],
            "pilotTiles": [item["tileId"] for item in inventory_result["pilotTiles"]],
        }
    elif args.command == "build-runtime-fixtures":
        generated = Path(args.generated_dir)
        result = build_runtime_fixtures(
            generated / "catalog" / "tile-catalog.json",
            generated / "fixtures",
        )
    elif args.command == "build-pilot-demand":
        config = load_world_config(args.config)
        generated = Path(args.generated_dir)
        raw = Path(args.raw_dir)
        report = compile_pilot_demand(
            config,
            generated / "catalog" / "tile-catalog.json",
            generated / "reports" / "lodes-tile-inventory.json",
            raw / "ny_xwalk.csv.gz",
            raw / "ny_od_main_JT01_2023.csv.gz",
            generated / "pilot",
            args.work_database or generated / "work" / "pilot-demand.sqlite",
            args.tiles,
        )
        result = {"valid": True, "pilotTiles": report["pilotTiles"], "elapsedSeconds": report["elapsedSeconds"], "tiles": report["tiles"]}
    elif args.command == "benchmark-pilot-routing":
        report = benchmark_routing(args.generated_dir, args.samples_per_tile)
        result = {"valid": report["status"] == "complete", "elapsedSeconds": report["elapsedSeconds"], "tiles": report["tiles"]}
    elif args.command == "benchmark-pilot":
        report = benchmark_pilot(args.generated_dir)
        result = {"valid": report["verdict"] == "PASS", "verdict": report["verdict"], "gates": report["gates"]}
    else:
        acquire_sources(args.lock, args.raw_dir, cache_dir=args.cache_dir)
        catalog_result = _catalog(args.config, args.raw_dir, args.generated_dir)
        inventory_result = _inventory(args.config, args.raw_dir, args.generated_dir)
        fixture_result = build_runtime_fixtures(
            Path(args.generated_dir) / "catalog" / "tile-catalog.json",
            Path(args.generated_dir) / "fixtures",
        )
        result = {
            "valid": True,
            "normalTiles": catalog_result["selection"]["normalCount"],
            "sliverTiles": catalog_result["selection"]["sliverCount"],
            "odRows": inventory_result["totals"]["odRows"],
            "workers": inventory_result["totals"]["workers"],
            "classificationWorkerDelta": inventory_result["totals"]["classificationWorkerDelta"],
            "pilotTiles": [item["tileId"] for item in inventory_result["pilotTiles"]],
            "fixturePackages": fixture_result["packageCount"],
        }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
