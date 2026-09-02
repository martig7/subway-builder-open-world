# Open World

Open World presents multiple geographic tile views as one persistent player world while Subway Builder remains authoritative for native saves and finances.

## Language

**World**:
One persistent open-world network and its off-tile simulation state, viewed through any number of geographic tiles.
_Avoid_: Campaign, universe

**World ID**:
A stable, opaque identifier created once for a World and retained across network edits, tile changes, manual saves, and autosaves.
_Avoid_: World hash, content hash

**Native Save**:
A Subway Builder save or autosave containing the authoritative rail topology, train inventory, clock, and financial ledger.
_Avoid_: World save, sidecar save

**Save Binding**:
The durable association from one Native Save identity to exactly one World ID.
_Avoid_: Recovery alias, inferred lineage

**Tile View**:
The currently selected geographic presentation of a World; changing it does not create or load a different World.
_Avoid_: Tile world, city save

**World Definition**:
A versioned, declarative description of a World's stable identity, Tile Views, geography, source datasets, and demand interpretation.
_Avoid_: World fork, consumer code, world config

**Tile Package**:
The reproducible map and demand artifacts that make one Tile View available to a runnable mod.
_Avoid_: City data, generated tile, mod copy

**Artifact Set**:
An immutable, hash-identified collection of a World's catalog, Tile Packages, world-level demand, and validation reports produced from one World Definition.
_Avoid_: Generated folder, latest build

**Demand Evidence**:
Canonical source observations, marginals, and origin-destination controls together with the conservation totals needed to compile a World's game demand.
_Avoid_: Demand package, game cohorts, source rows

**Build Shard**:
A resumable processing partition used to construct part of a Tile Package; it has no player-facing identity or save lineage.
_Avoid_: Tile View, World, prefecture mod

**Native Ledger**:
The balance and financial history owned exclusively by Subway Builder and carried by Native Saves.
_Avoid_: Sidecar finance, world finance

**World Record**:
The mod-owned navigation and off-tile simulation state associated with a World ID; it contains neither rail topology nor Native Ledger fields.
_Avoid_: World save, topology checkpoint, finance checkpoint

**Train Inventory and Route Assignment**:
The durable player intent describing owned rolling stock and the service assigned to routes.
_Avoid_: Live trains, rendered trains

**Train Rendering State**:
The transient visual representation of trains currently materialized in a Tile View.
_Avoid_: Train inventory, route assignment

**Train Simulation State**:
The operational state used to calculate train movement, departure phases, service, and passenger outcomes.
_Avoid_: Train rendering, route assignment
