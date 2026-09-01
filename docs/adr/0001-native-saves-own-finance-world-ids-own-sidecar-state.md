---
status: superseded by ADR-0002
---

# Native saves own finance; World IDs own sidecar state

Each new Subway Builder `gameSessionId` is the default stable World ID, while tile-transition session aliases can point multiple native sessions at one World ID. The mod catalog stores only names and bindings; money and financial history are always loaded from the selected native save, because restoring them from mod storage would create two competing financial authorities.

The in-game and main-menu panels group native manual saves and autosaves by World ID. Selecting an entry stages and loads that exact native save before the mod reconnects its finance-blind topology and off-tile state.
