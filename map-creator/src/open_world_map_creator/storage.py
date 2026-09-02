from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_value(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_bytes(canonical_json_bytes(value) + b"\n")
    os.replace(temporary, path)


class DataRoot:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.sources = self.root / "sources"
        self.work = self.root / "work"
        self.artifacts = self.root / "artifacts"
        self.logs = self.root / "logs"

    def create(self) -> None:
        for directory in (self.sources, self.work, self.artifacts, self.logs):
            directory.mkdir(parents=True, exist_ok=True)

    def source_object(self, sha256: str) -> Path:
        if len(sha256) != 64 or any(character not in "0123456789abcdef" for character in sha256):
            raise ValueError(f"Invalid SHA-256: {sha256}")
        return self.sources / "sha256" / sha256[:2] / sha256
