"""Immutable, resumable source acquisition driven by sources.lock.json."""
from __future__ import annotations

import json
import gzip
import hashlib
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .util import sha256_file, write_json


@dataclass(frozen=True)
class Source:
    id: str
    url: str
    sha256: str
    bytes: int
    vintage: str
    license: str
    hash_mode: str = "raw"


def load_lock(path: str | Path) -> list[Source]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    if raw.get("lock_version") != 1:
        raise ValueError("unsupported source lock version")
    result = []
    for item in raw.get("sources", []):
        required = ("id", "url", "sha256", "bytes", "vintage", "license")
        if any(key not in item for key in required):
            raise ValueError(f"source lock entry missing required field: {item!r}")
        result.append(Source(*(str(item[key]) if key != "bytes" else int(item[key]) for key in required), hash_mode=str(item.get("hash_mode", "raw"))))
    return result


def verify_source(path: Path, source: Source) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)
    if path.stat().st_size != source.bytes:
        raise ValueError(f"{source.id}: expected {source.bytes} bytes, got {path.stat().st_size}")
    if source.hash_mode == "raw":
        actual = sha256_file(path)
    elif source.hash_mode == "gzip-content":
        digest = hashlib.sha256()
        with gzip.open(path, "rb") as handle:
            while chunk := handle.read(1024 * 1024): digest.update(chunk)
        actual = digest.hexdigest()
    else:
        raise ValueError(f"{source.id}: unsupported hash mode {source.hash_mode}")
    if actual != source.sha256:
        raise ValueError(f"{source.id}: SHA-256 mismatch ({actual}, expected {source.sha256})")


def acquire_source(source: Source, destination: str | Path, *, timeout: int = 60) -> Path:
    """Download to a .part file, resume when HTTP Range is honored, then verify."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        verify_source(destination, source)
        return destination
    partial = destination.with_name(destination.name + ".part")
    start = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={start}-"} if start else {}
    request = urllib.request.Request(source.url, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.URLError as error:
        raise RuntimeError(f"could not acquire {source.id} from {source.url}: {error}") from error
    status = getattr(response, "status", response.getcode())
    # A server that ignores Range sends 200. Restart rather than appending a
    # duplicate body; this is the only safe resumability behavior.
    mode = "ab" if start and status == 206 else "wb"
    with response, partial.open(mode) as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    if partial.stat().st_size != source.bytes:
        raise ValueError(f"{source.id}: incomplete download ({partial.stat().st_size}/{source.bytes} bytes)")
    verify_source(partial, source)
    os.replace(partial, destination)
    return destination


def acquire_lock(lock_path: str | Path, raw_dir: str | Path) -> dict[str, Any]:
    raw_dir = Path(raw_dir)
    results = []
    for source in load_lock(lock_path):
        target = raw_dir / source.id
        acquire_source(source, target)
        results.append({"id": source.id, "path": str(target), "sha256": source.sha256, "bytes": source.bytes})
    report = {"retrieved_at": datetime.now(timezone.utc).isoformat(), "sources": results}
    write_json(raw_dir / "acquisition-report.json", report)
    return report
