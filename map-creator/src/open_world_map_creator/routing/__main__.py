from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .generated_roads import enrich_generated_road_driving


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
    command.add_argument("--cross-samples-per-tile-pair", type=int, default=4)
    command.add_argument("--no-resume", action="store_true")
    return command


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    if args.cross_samples_per_tile_pair < 1:
        raise SystemExit("--cross-samples-per-tile-pair must be positive")
    if args.progress_jsonl and args.progress_jsonl.exists() and args.no_resume:
        args.progress_jsonl.unlink()
    progress = JsonProgress(args.progress_jsonl)
    try:
        report = enrich_generated_road_driving(
            args.catalog,
            args.maps_dir,
            args.demand_dir,
            report_namespace=args.report_namespace,
            consumer_manifest_id=args.consumer_manifest_id,
            demand_report_name=args.demand_report_name,
            build_hash_prefix=args.build_hash_prefix,
            cross_samples_per_tile_pair=args.cross_samples_per_tile_pair,
            resume=not args.no_resume,
            progress=progress,
        )
    except Exception as error:
        progress(
            "routing failed",
            status="failed",
            errorType=type(error).__name__,
            error=str(error),
        )
        raise
    progress("routing complete", status="complete", report=report)
    print(json.dumps(report, ensure_ascii=True, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
