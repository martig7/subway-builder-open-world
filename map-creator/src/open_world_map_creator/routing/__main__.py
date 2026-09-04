from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .generated_roads import enrich_generated_road_driving
from .osrm import OsrmRouter


class JsonProgress:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.started = time.perf_counter()
        self.sequence = 0

    def __call__(self, message: str, *, status: str = "running", **details: Any) -> None:
        self.sequence += 1
        event = {
            "event": "road-routing-progress",
            "sequence": self.sequence,
            "stage": "road-routing",
            "status": status,
            "elapsedSeconds": round(time.perf_counter() - self.started, 3),
            "capturedAt": datetime.now(UTC).isoformat(),
            "message": message,
            **details,
        }
        durable_line = json.dumps(event, ensure_ascii=False, sort_keys=True)
        print(json.dumps(event, ensure_ascii=True, sort_keys=True), flush=True)
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8", newline="\n") as output:
                output.write(durable_line + "\n")


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        description="Transactionally enrich generated demand with generated-road driving times."
    )
    command.add_argument("--catalog", type=Path, required=True)
    command.add_argument("--maps-dir", type=Path, required=True)
    command.add_argument("--demand-dir", type=Path, required=True)
    command.add_argument("--report-namespace", required=True)
    command.add_argument("--consumer-manifest-id", required=True)
    command.add_argument("--demand-report-name")
    command.add_argument("--build-hash-prefix")
    command.add_argument("--progress-jsonl", type=Path)
    command.add_argument(
        "--routing-provider",
        choices=("generated-roads", "osrm"),
        default="generated-roads",
    )
    command.add_argument("--osrm-base-url", default="http://127.0.0.1:5000")
    command.add_argument("--osrm-profile", default="driving")
    command.add_argument("--osrm-dataset-id")
    command.add_argument("--osrm-cache", type=Path)
    command.add_argument("--osrm-workers", type=int, default=16)
    command.add_argument("--osrm-max-table-coordinates", type=int, default=100)
    command.add_argument("--osrm-timeout-seconds", type=float, default=60.0)
    command.add_argument("--max-routed-direct-metres", type=float)
    command.add_argument(
        "--invalidation",
        type=Path,
        help="Reroute only native cohorts and cross partitions named by this sidecar.",
    )
    command.add_argument("--cross-samples-per-tile-pair", type=int, default=4)
    command.add_argument("--no-resume", action="store_true")
    return command


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    if args.cross_samples_per_tile_pair < 1:
        raise SystemExit("--cross-samples-per-tile-pair must be positive")
    if args.osrm_workers < 1:
        raise SystemExit("--osrm-workers must be positive")
    if args.osrm_max_table_coordinates < 2:
        raise SystemExit("--osrm-max-table-coordinates must be at least 2")
    if args.routing_provider == "osrm" and not args.osrm_dataset_id:
        raise SystemExit("--osrm-dataset-id is required for durable OSRM cache identity")
    if args.progress_jsonl and args.progress_jsonl.exists() and args.no_resume:
        args.progress_jsonl.unlink()
    progress = JsonProgress(args.progress_jsonl)
    route_backend = None
    try:
        if args.routing_provider == "osrm":
            cache_path = args.osrm_cache or (
                args.demand_dir.parent / "cache" / "osrm-routes.sqlite3"
            )
            route_backend = OsrmRouter(
                base_url=args.osrm_base_url,
                profile=args.osrm_profile,
                dataset_id=args.osrm_dataset_id,
                cache_path=cache_path,
                workers=args.osrm_workers,
                max_table_coordinates=args.osrm_max_table_coordinates,
                timeout_seconds=args.osrm_timeout_seconds,
            )
            progress(
                "OSRM backend initialized",
                provider="osrm",
                datasetId=args.osrm_dataset_id,
                cachePath=str(cache_path),
            )
        routing_options: dict[str, Any] = {}
        if args.max_routed_direct_metres is not None:
            routing_options["max_routed_direct_metres"] = args.max_routed_direct_metres
        report = enrich_generated_road_driving(
            args.catalog,
            args.maps_dir,
            args.demand_dir,
            report_namespace=args.report_namespace,
            consumer_manifest_id=args.consumer_manifest_id,
            demand_report_name=args.demand_report_name,
            build_hash_prefix=args.build_hash_prefix,
            cross_samples_per_tile_pair=args.cross_samples_per_tile_pair,
            invalidation_path=args.invalidation,
            route_backend=route_backend,
            resume=not args.no_resume,
            progress=progress,
            **routing_options,
        )
    except Exception as error:
        progress(
            "routing failed",
            status="failed",
            errorType=type(error).__name__,
            error=str(error),
        )
        raise
    finally:
        if route_backend is not None:
            route_backend.close()
    progress("routing complete", status="complete", report=report)
    print(json.dumps(report, ensure_ascii=True, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
