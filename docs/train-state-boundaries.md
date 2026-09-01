# Train state boundaries

“Train state” is not one ownership domain. Changes must identify which of the following boundaries they touch before choosing an invalidation, persistence, or refresh path.

| Boundary | Representative state | Required care |
| --- | --- | --- |
| Train inventory and route assignment | Owned train and car counts, route `idealTrainCount`, frequency schedules, timetable schedules, and train-type assignment | Native Saves own this durable player intent. Inventory purchases require no open-world work. Service-affecting route changes only mark derived calculations dirty. |
| Train rendering | Materialized live train entities, visible positions, geometry, sprites, and render-layer data | This is transient presentation state. Avoid turning spawn, deletion, or position updates into full-world cache writes. Rendering changes can increase frame time, repaint frequency, memory use, and map-interaction latency. |
| Train simulation | Departure phase, movement progress, timing, capacity, dwell, and passenger-service state used by operational calculations | This is transient operational state unless an explicit model boundary captures it. Simulation changes can alter routing, wait-time, revenue, and mode-choice accuracy, so consumers must refresh it at the calculation boundary that needs it. |

A single native train object may carry both rendering and simulation fields. That does not make its lifecycle a durable inventory edit. Code that touches a train object must state whether it is changing player intent, visual materialization, or simulation inputs and should invalidate only the owning boundary.

Automatic `generateTrain`, `spawnTrainAtStation`, `deleteTrain`, `resetTrains`, `onTrainSpawned`, and `onTrainDeleted` activity belongs to the rendering/simulation lifecycle. It must not trigger a full open-world projection reconciliation. Inventory purchases also require no open-world invalidation because the native save owns that ground truth.

Route stop membership, train count, schedules, train type, station-group membership, and fares affect derived service, revenue, or mode choice. Their edit handlers only set constant-time dirty flags. The next calculation boundary—normally midnight—captures native network state once before rebuilding those derived values.

Blueprint edits, construction, station/route naming and styling, and blank route creation or design do not invalidate derived service. Native save/checkpoint and tile-handoff capture them at their existing authoritative boundaries. A tile handoff always captures the live native snapshot, so no eager cache is required to bridge the edit and the handoff.

Concrete live train state is captured at explicit authoritative boundaries such as tile transitions and native save/load. Calculations that need current service or departure phases refresh from native state at their own boundary instead of making editor or rendered-train lifecycle events persist the World Record.
