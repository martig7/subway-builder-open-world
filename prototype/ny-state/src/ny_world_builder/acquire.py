from __future__ import annotations

import shutil
import urllib.request
from pathlib import Path
from typing import Any

from .config import load_source_lock
from .util import sha256_file, write_json


def _verify(path: Path, source: dict[str, Any]) -> None:
    actual_bytes = path.stat().st_size
    if actual_bytes != int(source["bytes"]):
        raise ValueError(f"{path.name}: expected {source['bytes']} bytes, got {actual_bytes}")
    actual_sha = sha256_file(path)
    if actual_sha.lower() != str(source["sha256"]).lower():
        raise ValueError(f"{path.name}: SHA-256 mismatch: {actual_sha}")


def acquire_sources(
    lock_path: str | Path,
    raw_dir: str | Path,
    *,
    cache_dir: str | Path | None = None,
) -> dict[str, Any]:
    lock = load_source_lock(lock_path)
    destination = Path(raw_dir)
    destination.mkdir(parents=True, exist_ok=True)
    cache = Path(cache_dir) if cache_dir else None
    acquired: list[dict[str, Any]] = []

    for source in lock["sources"]:
        target = destination / source["filename"]
        origin = "existing"
        if not target.exists():
            cached = cache / source["filename"] if cache else None
            if cached and cached.exists():
                shutil.copyfile(cached, target)
                origin = "cache"
            else:
                temporary = target.with_suffix(target.suffix + ".download")
                urllib.request.urlretrieve(source["url"], temporary)
                temporary.replace(target)
                origin = "download"
        _verify(target, source)
        acquired.append({
            "id": source["id"],
            "filename": source["filename"],
            "bytes": target.stat().st_size,
            "sha256": sha256_file(target),
            "origin": origin,
        })

    report = {
        "schemaVersion": "1.0.0",
        "sourceLock": str(Path(lock_path).resolve()),
        "rawDirectory": str(destination.resolve()),
        "sources": acquired,
        "totalBytes": sum(item["bytes"] for item in acquired),
    }
    write_json(destination / "acquisition-report.json", report)
    return report

