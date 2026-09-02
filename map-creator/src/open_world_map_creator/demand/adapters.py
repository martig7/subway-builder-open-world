from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from ..worlds import LoadedWorld


class DemandAdapter(Protocol):
    name: str

    def normalize(self, world: LoadedWorld) -> dict[str, Any]: ...


@dataclass(frozen=True)
class LodesUsAdapter:
    name: str = "lodes-us"

    def normalize(self, world: LoadedWorld) -> dict[str, Any]:
        return _evidence(world, self.name, str(world.demand.get("vintage", "unknown")), "paired-observations")


@dataclass(frozen=True)
class EstatJapanAdapter:
    name: str = "estat-japan"

    def normalize(self, world: LoadedWorld) -> dict[str, Any]:
        return _evidence(world, self.name, str(world.demand.get("vintage", "current")), "marginals-and-od-controls")


def _evidence(world: LoadedWorld, adapter: str, vintage: str, model: str) -> dict[str, Any]:
    partitions = [tile["id"] for tile in world.tile_views]
    return {
        "schemaVersion": 1,
        "adapter": adapter,
        "sourceVintage": vintage,
        "sourceModel": model,
        "partitions": partitions,
        "observations": [],
        "marginals": [],
        "odControls": [],
        "conservation": {"inputMass": 0, "acceptedMass": 0, "rejectedMass": 0},
        "coverage": "configuration-normalized; source materialization pending",
    }


ADAPTERS: dict[str, DemandAdapter] = {adapter.name: adapter for adapter in (LodesUsAdapter(), EstatJapanAdapter())}


def demand_adapter(name: str) -> DemandAdapter:
    try:
        return ADAPTERS[name]
    except KeyError as error:
        raise ValueError(f"Unsupported Demand Adapter: {name}") from error
