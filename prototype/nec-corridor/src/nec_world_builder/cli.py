from __future__ import annotations

import argparse
import json
from pathlib import Path

from .acquire import acquire_sources
from .catalog import build_catalog, write_catalog
from .demand import build_nec_demand, default_nec_source_files
from .inventory import inventory_lodes
from .metrics import write_tile_metrics
from .selection import load_selection


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SELECTION = ROOT / "input" / "nec-corridor-selection.json"
DEFAULT_CATALOG = ROOT / "generated" / "catalog" / "nec-tile-catalog.json"
DEFAULT_COVERAGE = ROOT / "generated" / "coverage" / "nec-tile-coverage.geojson"
DEFAULT_INVENTORY = ROOT / "generated" / "reports" / "nec-lodes-inventory.json"
DEFAULT_MAP_INVENTORY = ROOT / "generated" / "reports" / "nec-lodes-map-demand.json"
DEFAULT_METRICS = ROOT / "generated" / "reports" / "nec-tile-metrics.json"
DEFAULT_PAIRS = ROOT / "generated" / "reports" / "nec-tile-pairs.csv"
DEFAULT_CONFIG = ROOT / "config" / "world-nec.json"
DEFAULT_LOCK = ROOT / "config" / "sources.lock.json"
DEFAULT_RAW_DIR = ROOT / "raw-data" / "lodes"
DEFAULT_ACQUISITION_REPORT = DEFAULT_RAW_DIR / "acquisition-report.json"
DEFAULT_RESOLVED_LOCK = ROOT / "config" / "sources.lock.resolved.json"
DEFAULT_DEMAND = ROOT / "generated" / "demand"
DEFAULT_DEMAND_DB = ROOT / "generated" / "work" / "nec-demand.sqlite"


def _state_path(value: str) -> tuple[str, str]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("expected STATE_FIPS=PATH")
    state, path = value.split("=", 1)
    if not state or not path:
        raise argparse.ArgumentTypeError("expected STATE_FIPS=PATH")
    return state, path


def _selection_path(parser: argparse.ArgumentParser, value: str) -> Path:
    path = Path(value)
    if not path.is_file():
        parser.error(f"selection file not found: {path}")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="nec-world", description="Northeast Corridor LODES prototype")
    commands = parser.add_subparsers(dest="command", required=True)

    catalog = commands.add_parser("build-catalog")
    catalog.add_argument("--selection", default=str(DEFAULT_SELECTION))
    catalog.add_argument("--boundary", help="optional Census state boundary ZIP or shapefile")
    catalog.add_argument("--catalog-out", default=str(DEFAULT_CATALOG))
    catalog.add_argument("--coverage-out", default=str(DEFAULT_COVERAGE))

    inventory = commands.add_parser("inventory-lodes")
    inventory.add_argument("--selection", default=str(DEFAULT_SELECTION))
    inventory.add_argument("--crosswalk", action="append", type=_state_path, required=True)
    inventory.add_argument("--main", action="append", type=_state_path, default=[])
    inventory.add_argument("--aux", action="append", type=_state_path, default=[])
    inventory.add_argument("--map-only", action="store_true", help="retain only rows whose home and workplace are both in selected tiles")
    inventory.add_argument("--out", default=str(DEFAULT_INVENTORY))

    metrics = commands.add_parser("build-metrics")
    metrics.add_argument("--inventory", default=str(DEFAULT_MAP_INVENTORY))
    metrics.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    metrics.add_argument("--out", default=str(DEFAULT_METRICS))
    metrics.add_argument("--pairs-out", default=str(DEFAULT_PAIRS))

    demand = commands.add_parser("build-demand")
    demand.add_argument("--selection", default=str(DEFAULT_SELECTION))
    demand.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    demand.add_argument("--inventory", default=str(DEFAULT_MAP_INVENTORY))
    demand.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR))
    demand.add_argument("--out", default=str(DEFAULT_DEMAND))
    demand.add_argument("--work-database", default=str(DEFAULT_DEMAND_DB))
    demand.add_argument("--tile", action="append", dest="tiles")

    acquire = commands.add_parser("acquire-sources")
    acquire.add_argument("--config", default=str(DEFAULT_CONFIG), help="world config used for the default state list")
    acquire.add_argument("--lock", default=str(DEFAULT_LOCK))
    acquire.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR))
    acquire.add_argument("--state", action="append", dest="states", help="limit acquisition to a state code; repeatable")
    acquire.add_argument("--role", action="append", dest="roles", choices=["lodes-main", "lodes-aux", "lodes-crosswalk"], help="limit acquisition to a source role; repeatable")
    acquire.add_argument("--force", action="store_true", help="redownload files even when they already exist")
    acquire.add_argument("--timeout", type=int, default=120)
    acquire.add_argument("--report-out", default=str(DEFAULT_ACQUISITION_REPORT))
    acquire.add_argument("--resolved-lock-out", default=str(DEFAULT_RESOLVED_LOCK))

    args = parser.parse_args(argv)

    if args.command == "acquire-sources":
        config = json.loads(Path(args.config).read_text(encoding="utf-8"))
        states = args.states or config["states"]["workplaceJurisdictions"]
        report = acquire_sources(
            args.lock,
            args.raw_dir,
            [state.lower() for state in states],
            force=args.force,
            timeout=args.timeout,
            roles=args.roles,
            report_path=args.report_out,
            resolved_lock_path=args.resolved_lock_out,
        )
        print(json.dumps({"valid": True, **report["totals"], "report": args.report_out}, sort_keys=True))
        return 0

    if args.command == "build-metrics":
        report = write_tile_metrics(args.inventory, args.out, args.pairs_out, args.catalog)
        print(json.dumps({"valid": True, "tileCount": len(report["tiles"]), "tilePairCount": report["tilePairCount"], "out": args.out, "pairsOut": args.pairs_out}, sort_keys=True))
        return 0

    selection_path = _selection_path(parser, args.selection)
    selection = load_selection(selection_path)

    if args.command == "build-demand":
        crosswalk, main, aux = default_nec_source_files(args.raw_dir)
        report = build_nec_demand(selection, args.catalog, args.inventory, crosswalk, main, aux, args.out, args.work_database, args.tiles)
        print(json.dumps({"valid": True, "tiles": len(report["tiles"]), "inputWorkers": report["inputWorkers"], "crossTileWorkers": report["crossTileWorkers"], "out": args.out}, sort_keys=True))
        return 0

    if args.command == "build-catalog":
        catalog_result, coverage = build_catalog(selection, args.boundary)
        write_catalog(catalog_result, coverage, args.catalog_out, args.coverage_out)
        print(json.dumps({"valid": True, "selectedTiles": len(selection.tiles), "catalog": args.catalog_out}, sort_keys=True))
        return 0

    report = inventory_lodes(selection, args.crosswalk, args.main, args.aux, args.out, map_only=args.map_only)
    print(json.dumps({"valid": True, "scope": report["scope"], "inputRows": report["totals"]["inputRows"], "inputWorkers": report["totals"]["inputWorkers"], "out": args.out}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
