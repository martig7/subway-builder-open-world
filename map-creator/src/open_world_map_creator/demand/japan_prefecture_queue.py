from __future__ import annotations

import argparse
import json
from pathlib import Path

from .estat_japan_prefecture import (
    DEFAULT_BOUNDARY,
    DEFAULT_OUTPUT,
    DEFAULT_RAW,
    PREFECTURE_NAMES,
    Progress,
    WORKER_VERSION,
    build_prefecture_evidence,
    sha256,
)


DEFAULT_QUEUE = tuple(f"{code:02d}" for code in range(1, 48) if code not in {13, 14})
REQUIRED_OUTPUTS = (
    "world-boundary.geojson",
    "home-mesh-250m.geojson",
    "job-mesh-500m.geojson",
    "demand-site-candidates.geojson",
    "municipality-od.json",
    "demand-evidence.json",
    "report.json",
)


def is_complete(output: Path, boundary_sha256: str | None = None) -> bool:
    report_path = output / "report.json"
    if not report_path.is_file() or any(not (output / name).is_file() for name in REQUIRED_OUTPUTS):
        return False
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        report.get("status") == "demand-evidence-complete"
        and report.get("workerVersion") == WORKER_VERSION
        and (
            boundary_sha256 is None
            or report.get("renderBoundary", {}).get("sha256") == boundary_sha256
        )
    )


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Process Japan's prefectures sequentially with resumable outputs.")
    command.add_argument("--prefecture", action="append", dest="prefectures")
    command.add_argument("--raw-root", type=Path, default=DEFAULT_RAW)
    command.add_argument("--boundary-source", type=Path, default=DEFAULT_BOUNDARY)
    command.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT)
    command.add_argument("--progress-jsonl", type=Path)
    command.add_argument("--site-radius-m", type=float, default=350)
    command.add_argument("--no-resume", action="store_true")
    return command


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    prefecture_codes = args.prefectures or list(DEFAULT_QUEUE)
    if any(code not in PREFECTURE_NAMES for code in prefecture_codes):
        raise SystemExit("--prefecture must be a two-digit code from 01 through 47")
    if len(set(prefecture_codes)) != len(prefecture_codes):
        raise SystemExit("--prefecture values must be unique")
    if args.site_radius_m < 250:
        raise SystemExit("--site-radius-m must be at least 250")
    progress_path = args.progress_jsonl or args.output_root / "queue-progress.jsonl"
    if args.no_resume and progress_path.exists():
        progress_path.unlink()
    progress = Progress(progress_path)
    boundary_sha256 = sha256(args.boundary_source)
    progress.emit(
        "queue",
        "started",
        queueTotal=len(prefecture_codes),
        prefectureCodes=prefecture_codes,
        prefectureNames=[PREFECTURE_NAMES[code] for code in prefecture_codes],
        resume=not args.no_resume,
    )
    for queue_index, code in enumerate(prefecture_codes, 1):
        output = args.output_root / f"JP_PREF_{code}"
        if not args.no_resume and is_complete(output, boundary_sha256):
            progress.emit(
                "queue-item",
                "skipped-complete",
                queueIndex=queue_index,
                queueTotal=len(prefecture_codes),
                prefectureCodes=[code],
                prefectureNames=[PREFECTURE_NAMES[code]],
                tileIds=[f"JP_PREF_{code}"],
                output=str(output),
            )
            continue
        try:
            build_prefecture_evidence(
                prefecture_codes=[code],
                raw_root=args.raw_root,
                boundary_source=args.boundary_source,
                output=output,
                site_radius_m=args.site_radius_m,
                progress=progress,
                queue_index=queue_index,
                queue_total=len(prefecture_codes),
            )
        except Exception as error:
            progress.emit(
                "queue",
                "failed",
                queueIndex=queue_index,
                queueTotal=len(prefecture_codes),
                prefectureCodes=[code],
                prefectureNames=[PREFECTURE_NAMES[code]],
                errorType=type(error).__name__,
                error=str(error),
            )
            raise
    progress.emit("queue", "complete", queueTotal=len(prefecture_codes), outputRoot=str(args.output_root))


if __name__ == "__main__":
    main()
