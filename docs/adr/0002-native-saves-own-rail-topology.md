---
status: accepted
---

# Native saves own rail topology

Native Saves are the sole durable authority for rail topology as well as finance. A World Record contains only navigation and off-tile simulation state; tile changes copy the live native network in memory and ordinary save loads rebuild runtime projections and caches from the loaded Native Save. We reject durable sidecar topology, clipped-save migration, and crash-recovery topology journals because they create a competing authority and permanent complexity for obsolete or one-time recovery cases.

Players create, name, select, and load saves through Subway Builder's native save UI. The mod does not maintain a parallel save catalog, saved-world browser, or user-selectable canonical lineage. Save Bindings remain mod-owned because they reconnect a loaded Native Save to its finance- and topology-blind World Record. Legacy catalog and canonical-lineage records may remain in storage for rollback, but current runtimes ignore them.
