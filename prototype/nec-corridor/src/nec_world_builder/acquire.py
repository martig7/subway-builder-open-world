from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


USER_AGENT = "NEC-LODES-Prototype/0.1 (+https://www.census.gov/programs-surveys/ces/data/lehd.html)"


def load_source_lock(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def lodes_manifest(
    lock: dict[str, Any],
    states: Iterable[str] | None = None,
    roles: Iterable[str] | None = None,
) -> list[dict[str, str]]:
    state_group = next(source for source in lock["sources"] if source.get("id") == "lodes-state-files")
    selected = {str(state).lower() for state in states} if states else set(state_group["states"])
    unknown = selected - {str(state).lower() for state in state_group["states"]}
    if unknown:
        raise ValueError(f"states not present in source lock: {', '.join(sorted(unknown))}")
    available_roles = {str(template["role"]) for template in state_group["files"]}
    selected_roles = {str(role) for role in roles} if roles else available_roles
    unknown_roles = selected_roles - available_roles
    if unknown_roles:
        raise ValueError(f"roles not present in source lock: {', '.join(sorted(unknown_roles))}")

    manifest: list[dict[str, str]] = []
    for state in state_group["states"]:
        state = str(state).lower()
        if state not in selected:
            continue
        for template in state_group["files"]:
            if str(template["role"]) not in selected_roles:
                continue
            manifest.append(
                {
                    "state": state,
                    "filename": str(template["filename"]).format(state=state),
                    "url": str(template["url"]).format(state=state),
                    "role": str(template["role"]),
                }
            )
    return manifest


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _download(url: str, target: Path, timeout: int) -> None:
    partial = target.with_name(target.name + ".part")
    if partial.exists():
        partial.unlink()
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        os.replace(partial, target)
    finally:
        if partial.exists():
            partial.unlink()


def acquire_sources(
    lock_path: str | Path,
    raw_dir: str | Path,
    states: Iterable[str] | None = None,
    force: bool = False,
    timeout: int = 120,
    roles: Iterable[str] | None = None,
    report_path: str | Path | None = None,
    resolved_lock_path: str | Path | None = None,
) -> dict[str, Any]:
    lock = load_source_lock(lock_path)
    target_dir = Path(raw_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest = lodes_manifest(lock, states, roles)
    checked_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    records: list[dict[str, Any]] = []

    for source in manifest:
        target = target_dir / source["filename"]
        target.parent.mkdir(parents=True, exist_ok=True)
        status = "existing"
        if force or not target.is_file():
            _download(source["url"], target, timeout)
            status = "downloaded"
        records.append(
            {
                **source,
                "path": str(target),
                "status": status,
                "bytes": target.stat().st_size,
                "sha256": sha256_file(target),
                "checkedAt": checked_at,
            }
        )

    report: dict[str, Any] = {
        "schemaVersion": "0.1.0",
        "sourceSet": lock.get("sourceSet"),
        "generatedAt": checked_at,
        "rawDirectory": str(target_dir),
        "roleFilter": sorted({record["role"] for record in records}),
        "sources": records,
        "totals": {
            "requestedFiles": len(records),
            "downloadedFiles": sum(record["status"] == "downloaded" for record in records),
            "existingFiles": sum(record["status"] == "existing" for record in records),
            "bytes": sum(record["bytes"] for record in records),
        },
    }
    if report_path:
        report_target = Path(report_path)
        report_target.parent.mkdir(parents=True, exist_ok=True)
        report_target.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")

    if resolved_lock_path:
        resolved_sources = []
        boundary = next((source for source in lock["sources"] if source.get("id") != "lodes-state-files"), None)
        if boundary:
            resolved_sources.append(boundary)
        resolved_sources.append(
            {
                "id": "lodes-state-files",
                "states": sorted({record["state"] for record in records}),
                "files": [
                    {
                        "state": record["state"],
                        "filename": record["filename"],
                        "url": record["url"],
                        "role": record["role"],
                        "bytes": record["bytes"],
                        "sha256": record["sha256"],
                    }
                    for record in records
                ],
            }
        )
        resolved = {**lock, "notes": "Expanded acquisition manifest with observed file sizes and SHA-256 hashes.", "sources": resolved_sources}
        resolved_target = Path(resolved_lock_path)
        resolved_target.parent.mkdir(parents=True, exist_ok=True)
        resolved_target.write_text(json.dumps(resolved, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")

    return report
