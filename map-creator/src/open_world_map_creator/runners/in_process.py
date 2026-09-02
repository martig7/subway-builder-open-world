from __future__ import annotations

from typing import Any

from ..stages import execute_stage


class InProcessRunner:
    name = "in-process"

    def run(self, manifest: dict[str, Any]) -> dict[str, Any]:
        return execute_stage(manifest)
