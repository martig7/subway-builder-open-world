---
status: accepted
---

# Cached simulation temporarily owns the native tick

Ultra-high-speed mode is an explicit option in Map rendering. The user's on/off
choice is remembered between sessions for each runnable mod, independently of
Native Save selection. Lifecycle shutdowns and temporary tile handoff holds do
not change that preference. New installations default to off; upgrading a live
older runtime retains its current choice.
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
midnight batch. Its active-tile preparation and cross-network recalculation
share one routing allocation slot, and duplicate day hooks await that same batch. The cached clock
stops exactly at midnight, settling old rates to the boundary, and waits for
both calculations before the next tick. Incomplete work remains queued.

Both commute owners use the same committed-service observer and public schedule
and fare hooks. Blank route design/deletion, cosmetic edits, construction,
inventory changes, and live train/reference replacements do not independently
queue demand work in cached mode. Raw store changes can update expense rates and
billing anchors without widening the shared commute invalidation policy.

The regular native-demand pass prepares the active Tile View's assignments even
while cached ticks are disabled. Batches of 128 pops are written to a disposable
IndexedDB cache, separate from World Records and Native Saves. One committed
generation replaces the previous generation, with a 256 MiB / 4096-chunk bound.
The main renderer receives its finance profile without dormant assignments.
SHA-256 keys include the session, exact compact demand (including departures),
configured routing network, rules and fares. Moving train anchors do not enter
this deterministic estimator's key. Cache failures permit bounded recomputation.

Enabling the mode reads valid assignments from disk or prepares them immediately.
A changed save, Tile
View, or demand set cannot reuse another context's assignments until midnight.
A late worker response cannot publish into another save, a disabled mode, or
over a newer edit. An edit during a running batch remains queued for the next
midnight. Caches are never allowed to cross a save or demand replacement.

The active prepared profile is excluded from background ledger posting and is
marked separately from an inactive deterministic profile. Inactive evaluation
must refresh it when ownership changes. Native and cross-city evaluator workers
release their heaps after jobs, preserving routing caches only within a job.
Their routing caches retain at most 8000 source-search labels, 1024 paths and
4096 catchments. Smaller caches may require more searches, but do not approximate
journeys. Worker failures do not retry full demand inside the main renderer.
Fresh diagnostics defer new work at 3.25 GiB of combined allocated heap pages or
less than 512 MiB of main-isolate limit margin. This is a conservative admission
policy based on observed crashes, not a V8 limit or a guarantee against OOM.
Missing/stale measurements use serial execution without inventing headroom.

Subway Builder 1.7's native commute pool otherwise creates one worker per logical
CPU and retains a separate routing network in each. For the verified
`popCommuteWorker.worker-CI81Zuw7.js` protocol, an early constructor adapter keeps
the game's logical workers and executes their unchanged batches through at most
six physical workers. Fresh combined allocation above 3 GiB lowers concurrency
to two, and above 3.25 GiB to one. In-flight batches finish before downsizing;
five seconds without work retires the physical heaps. Shared network versions
are cloned once for queued requests, restored when a physical worker is reused,
and never substituted across logical requests. Other worker scripts and unknown
game builds pass through. This may reduce native routing throughput, but removes
the observed 1.5 GiB commitment from 24 idle commute workers. A full game launch
is required to capture the native pool's initial construction.

Disk chunks use gzip independently. The live Tokyo profile exceeded the 256 MiB
cap with repeated uncompressed route lists; chunk compression keeps temporary
allocations bounded and the limit applies to bytes actually stored. Cache
generation changes clear the previous records in the same database.

The preference persists only a boolean, not a second save authority. Saving
preserves the synchronous native save contract, settles the current interval,
and shifts frozen train timing anchors in the saved copy. Disabling shifts the
live anchors and clears transient passenger movements, preserving train IDs,
inventory and physical positions. Previously accrued native operating costs
remain payable; time already accounted for by this mode is excluded.

This is an estimate, not an equivalent execution of the native simulator.
Capacity, congestion caused by trains, missed connections, signal delays and
reliability are not simulated. Infrastructure expenses use the shared estimate
and native train-type prices, including constructed grade crossings. Native
simulation returns when the toggle is disabled. Loading/reloading initially
disables execution, then restores the remembered choice after network and
finance preparation. The new context validates or computes its own assignments;
old session caches and ledger state are never restored from preferences. A user
changing the preference during loading wins over the delayed restoration, and
ended or replaced sessions cannot enable the next session's simulation.
An explicit Tile View navigation in the same live World carries
the player's enabled intent through a temporary handoff hold. The source first
settles and rebases once, drains observed native actions, and drops its cached
assignments. The destination prepares its own assignments while the clock is
held; it does not borrow the source Tile View's journeys. Native commute work
is suppressed during this hold only when cached mode was requested. Ordinary
native-mode navigation still repairs native journeys.

Map readiness and simulation readiness are separate. Destination demand and
off-tile finance preparation continue after map attachment, with heavy work
serialized. The clock remains held until both owners are ready, and another
tile navigation cannot overtake that preparation. A failed preparation is
retryable and leaves time stopped. Loading an unrelated Native Save, ending the
session, or disposing the runtime cancels the handoff intent; it cannot enable
cached mode or publish a late result into the replacement session.
