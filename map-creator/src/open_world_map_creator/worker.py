from __future__ import annotations

import json
import sys
from pathlib import Path

from .stages import execute_stage
from .storage import atomic_json


def main() -> None:
    input_path, output_path = map(Path, sys.argv[1:3])
    atomic_json(output_path, execute_stage(json.loads(input_path.read_text(encoding="utf-8"))))


if __name__ == "__main__":
    main()
