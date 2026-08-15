from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import quote
from urllib.request import urlopen

from .util import write_json


@dataclass(frozen=True)
class DrivingRoute:
    duration_seconds: float
    distance_metres: float

    def __post_init__(self) -> None:
        if not (self.duration_seconds >= 0 and self.distance_metres >= 0):
            raise ValueError("driving routes require non-negative duration and distance")


class DrivingRouter(Protocol):
    @property
    def metadata(self) -> dict[str, Any]: ...

    def route(self, origin: tuple[float, float], destination: tuple[float, float]) -> DrivingRoute: ...


class OsrmDrivingRouter:
    """Cached build-time adapter for OSRM's fastest-route interface."""

    def __init__(
        self,
        base_url: str,
        *,
        profile: str = "driving",
        dataset_id: str,
        cache_path: str | Path | None = None,
        timeout_seconds: float = 30,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        if not dataset_id.strip():
            raise ValueError("OSRM dataset_id is required so cached routes cannot silently outlive the road graph")
        self.base_url = base_url.rstrip("/")
        self.profile = profile
        self.dataset_id = dataset_id
        self.cache_path = Path(cache_path) if cache_path else None
        self.timeout_seconds = timeout_seconds
        self.opener = opener
        self._cache: dict[str, dict[str, float]] = {}
        if self.cache_path and self.cache_path.exists():
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            expected = {"provider": "osrm", "profile": profile, "datasetId": dataset_id}
            if payload.get("metadata") != expected:
                raise ValueError("OSRM route cache metadata does not match the requested road dataset")
            self._cache = dict(payload.get("routes", {}))

    @property
    def metadata(self) -> dict[str, Any]:
        return {"provider": "osrm", "profile": self.profile, "datasetId": self.dataset_id}

    @staticmethod
    def _coordinate(value: tuple[float, float]) -> str:
        return f"{value[0]:.6f},{value[1]:.6f}"

    def _key(self, origin: tuple[float, float], destination: tuple[float, float]) -> str:
        return f"{self._coordinate(origin)};{self._coordinate(destination)}"

    def route(self, origin: tuple[float, float], destination: tuple[float, float]) -> DrivingRoute:
        key = self._key(origin, destination)
        cached = self._cache.get(key)
        if cached:
            return DrivingRoute(cached["duration_seconds"], cached["distance_metres"])
        coordinates = quote(key, safe=",.;-")
        url = f"{self.base_url}/route/v1/{quote(self.profile, safe='')}/{coordinates}?overview=false&steps=false&alternatives=false"
        with self.opener(url, timeout=self.timeout_seconds) as response:
            payload = json.load(response)
        if payload.get("code") != "Ok" or not payload.get("routes"):
            raise RuntimeError(f"OSRM could not route {key}: {payload.get('code', 'invalid response')}")
        first = payload["routes"][0]
        result = DrivingRoute(float(first["duration"]), float(first["distance"]))
        self._cache[key] = asdict(result)
        return result

    def close(self) -> None:
        if self.cache_path:
            write_json(self.cache_path, {"metadata": self.metadata, "routes": self._cache})

    def __enter__(self) -> "OsrmDrivingRouter":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()
