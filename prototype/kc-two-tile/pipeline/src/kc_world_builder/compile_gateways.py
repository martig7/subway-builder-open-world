from __future__ import annotations

from .config import Gateway, WorldConfig


def choose_gateway(config: WorldConfig, home: tuple[float, float], work: tuple[float, float]) -> Gateway:
    """Deterministic least-cost proxy until a corridor OSRM cost matrix exists.

    Squared straight-line access distance is monotonic and deterministic.  Ties
    are broken by stable gateway ID so rebuilds cannot move a cohort arbitrarily.
    """
    def cost(gateway: Gateway) -> tuple[float, str]:
        return ((home[0] - gateway.x) ** 2 + (home[1] - gateway.y) ** 2 + (work[0] - gateway.x) ** 2 + (work[1] - gateway.y) ** 2, gateway.id)
    return min(config.gateways, key=cost)
