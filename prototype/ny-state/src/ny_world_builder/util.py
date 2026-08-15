from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def sha256_file(path: str | Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_text(path: str | Path, text: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    temporary.replace(target)


def write_json(path: str | Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, indent=2, sort_keys=True) + "\n")


def stable_tile_id(column: int, row: int) -> str:
    def part(prefix: str, value: int) -> str:
        return f"{prefix}{'P' if value >= 0 else 'M'}{abs(value):02d}"

    return f"NY_{part('C', column)}_{part('R', row)}"


def game_city_code(column: int, row: int) -> str:
    return stable_tile_id(column, row).replace("_", "")

