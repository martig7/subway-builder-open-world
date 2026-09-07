---
status: accepted
---

# Cached simulation temporarily owns the native tick

Ultra-high-speed mode is an explicit, session-local option in Map rendering.
It replaces native train, signal, crowd and pop simulation with disposable
calculated demand and finance profiles. The clock continues; Ultra speed uses
ten times its ordinary clock increment. Other speed tiers keep their configured
increments. Native Saves remain authoritative for topology, inventory, time and
the Native Ledger.

While the mode owns the tick, it posts estimated active-tile revenue and
full-network expenses through native ledger actions. The existing World runtime
continues to post inactive-tile native revenue and custom cross-tile revenue.
The two owners do not post the same interval or revenue stream. Partial hours
are integrated at cached hourly rates, including when disabling or saving.
Native bond processing remains active. Ridership records use people rather
than the annualization multiplier used for money.

Assignments include both commute directions for every loaded native pop,
including walking, driving and unknown outcomes. Native demand maps, pop cards
and route highlights consume native-shaped results from the same calculations.
Service/fare edits invalidate calculations. A late worker response cannot
publish into another save or a disabled mode. Time waits for a current cache.

Caches and the toggle are not persisted as a second save authority. Saving
preserves the synchronous native save contract, settles the current interval,
and shifts frozen train timing anchors in the saved copy. Disabling shifts the
live anchors and clears transient passenger movements, preserving train IDs,
inventory and physical positions. Previously accrued native operating costs
remain payable; time already accounted for by this mode is excluded.

This is an estimate, not an equivalent execution of the native simulator.
Capacity, congestion caused by trains, missed connections, signal delays and
reliability are not simulated. Infrastructure expenses use the shared estimate
and native train-type prices, including constructed grade crossings. Native
simulation returns when the toggle is disabled; loading/reloading starts with
the toggle off.
