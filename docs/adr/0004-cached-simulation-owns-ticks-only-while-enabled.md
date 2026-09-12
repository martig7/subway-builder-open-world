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
Service/fare edits mark commute assignments stale for the next midnight. The
current assignments continue through the day; expense rates and train billing
anchors still update at edit time. Multiple edits coalesce into one shared
midnight batch. Its active-tile worker and cross-network recalculation start
concurrently, and duplicate day hooks await that same batch. The cached clock
stops exactly at midnight, settling old rates to the boundary, and waits for
both calculations before the next tick. Incomplete work remains queued.

Both commute owners use the same committed-service observer and public schedule
and fare hooks. Blank route design/deletion, cosmetic edits, construction,
inventory changes, and live train/reference replacements do not independently
queue demand work in cached mode. Raw store changes can update expense rates and
billing anchors without widening the shared commute invalidation policy.

Enabling the mode still prepares assignments immediately. A changed save, Tile
View, or demand set cannot reuse another context's assignments until midnight.
A late worker response cannot publish into another save, a disabled mode, or
over a newer edit. An edit during a running batch remains queued for the next
midnight. Caches are never allowed to cross a save or demand replacement.

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
