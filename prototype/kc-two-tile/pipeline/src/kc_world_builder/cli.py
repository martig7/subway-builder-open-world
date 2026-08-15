from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .acquire import acquire_lock
from .build_maps import build_halo_assets
from .compile_demand import Cohort, compile_cohorts
from .config import load_world_config
from .driving_routes import OsrmDrivingRouter
from .normalize_lodes import build_crosswalk_index, normalize_od_files
from .package import package_tiles
from .util import iter_jsonl, write_json
from .validate import validate_conservation


def _config_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", default=str(Path(__file__).parents[2] / "config" / "world.yaml"))


def _cohorts_from_jsonl(path: str | Path) -> list[Cohort]:
    return [Cohort(**row) for row in iter_jsonl(Path(path))]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kc-world-builder")
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate-config"); _config_argument(validate)
    acquire = commands.add_parser("acquire"); acquire.add_argument("--lock", required=True); acquire.add_argument("--raw-dir", required=True)
    crosswalk = commands.add_parser("build-crosswalk-index"); crosswalk.add_argument("--input", action="append", required=True); crosswalk.add_argument("--output", required=True); crosswalk.add_argument("--project-wgs84", action="store_true", help="project official lon/lat LODES crosswalks to EPSG:26915 (requires pyproj)")
    normalize = commands.add_parser("normalize-lodes"); _config_argument(normalize); normalize.add_argument("--crosswalk-index", required=True); normalize.add_argument("--output", required=True); normalize.add_argument("--source", action="append", required=True, metavar="STATE:KIND:PATH")
    compile_cmd = commands.add_parser("compile-demand"); _config_argument(compile_cmd); compile_cmd.add_argument("--od", required=True); compile_cmd.add_argument("--output", required=True)
    package = commands.add_parser("package"); _config_argument(package); package.add_argument("--cohorts", required=True); package.add_argument("--output-dir", required=True)
    package.add_argument("--router-url", help="build-time OSRM endpoint, normally a local osrm-routed instance")
    package.add_argument("--router-profile", default="driving")
    package.add_argument("--router-dataset-id", help="immutable road-extract/version identifier used to validate the route cache")
    package.add_argument("--routing-cache", help="persistent JSON cache for origin-destination route results")
    maps = commands.add_parser("build-maps"); _config_argument(maps); maps.add_argument("--features", required=True); maps.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    if args.command == "acquire":
        print(json.dumps(acquire_lock(args.lock, args.raw_dir), sort_keys=True)); return 0
    if args.command == "build-crosswalk-index":
        print(json.dumps({"blocks": build_crosswalk_index(args.input, args.output, project_wgs84=args.project_wgs84)}, sort_keys=True)); return 0
    config = load_world_config(args.config)
    if args.command == "validate-config":
        print(json.dumps({"valid": True, "tiles": [tile.id for tile in config.tiles]}, sort_keys=True)); return 0
    if args.command == "normalize-lodes":
        sources = []
        for item in args.source:
            try: state, kind, filename = item.split(":", 2)
            except ValueError: parser.error("--source is STATE:main|aux:PATH")
            sources.append((state, kind, filename))
        print(json.dumps(normalize_od_files(config, args.crosswalk_index, sources, args.output), sort_keys=True)); return 0
    if args.command == "compile-demand":
        cohorts, report = compile_cohorts(config, iter_jsonl(Path(args.od)))
        output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("w", encoding="utf-8") as handle:
            for cohort in cohorts: handle.write(json.dumps(cohort.__dict__, sort_keys=True, separators=(",", ":")) + "\n")
        report.update(validate_conservation(config, cohorts, expected_mass=sum(int(row["S000"]) for row in iter_jsonl(Path(args.od)))))
        write_json(output.with_suffix(".report.json"), report); print(json.dumps(report, sort_keys=True)); return 0
    if args.command == "package":
        if args.router_url and not args.router_dataset_id:
            parser.error("--router-dataset-id is required with --router-url")
        if args.router_url:
            with OsrmDrivingRouter(
                args.router_url,
                profile=args.router_profile,
                dataset_id=args.router_dataset_id,
                cache_path=args.routing_cache,
            ) as router:
                result = package_tiles(config, _cohorts_from_jsonl(args.cohorts), args.output_dir, driving_router=router)
        else:
            result = package_tiles(config, _cohorts_from_jsonl(args.cohorts), args.output_dir)
        print(json.dumps(result, sort_keys=True)); return 0
    if args.command == "build-maps":
        print(json.dumps(build_halo_assets(config, args.features, args.output_dir), sort_keys=True)); return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
