from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


class SubprocessRunner:
    name = "subprocess"

    def run(self, manifest: dict[str, Any]) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="ow-map-runner-") as directory:
            root = Path(directory)
            input_path = root / "run.json"
            output_path = root / "result.json"
            input_path.write_text(json.dumps(manifest), encoding="utf-8")
            subprocess.run(
                [sys.executable, "-m", "open_world_map_creator.worker", str(input_path), str(output_path)],
                check=True,
                text=True,
            )
            return json.loads(output_path.read_text(encoding="utf-8"))
