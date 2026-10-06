## Polygon ownership and induced cross-tile demand, 2026-10-06

The v8 bridge requires ownership and growth capabilities before Open World growth begins. Japan uses the original prefecture polygons, including holes and deterministic border ownership; NEC uses the original EPSG:26918 half-open grid. The rectangular native map halo remains a rendering and mask allocation bound. It no longer decides which tile owns growth sites, cell integration, cuts, or induced commute endpoints.

Growth uses a disposable combined model containing native active-tile demand and virtual extension cohorts. Served foreign job endpoints come from the packaged cross-demand catalog, with a 2,048-candidate cap and exact walking catchment checks. Foreign endpoints cannot accumulate residential pressure or create cells. Existing cross cohorts retain their endpoints; unused foreign pressure banks leave the model when they leave the bounded candidate set. The supported editor receives only active-owned points and local cohorts. Foreign trips and endpoint descriptors remain in one immutable extension checkpoint under the originating tile. Native API-generated local IDs and stable virtual cross IDs are checkpointed separately.

Open World's projected cross catalog supplies the Cross-city demand viewer, generated route paths, modal evaluator and cheap hourly simulator. Induced flow IDs are scoped by origin tile and extension, and use separate synthetic groups to prevent packaged gateway totals from being assigned twice. Geometry/cohort changes revise the catalog; ledger pressure and unused candidate descriptors do not. New, resized and retired groups preserve elapsed cursors and earned/pending receipts, and start at the current hour without historical revenue. Hourly settlement catches a missed refresh notification. Both native and cached clocks use this path; the global Cached Simulation preference is unchanged.

Legacy foreign extension demand migrates away from native tile demand through supported editor calls when its originating tile activates. Ownership and exact native-record proofs run before edits. Old immutable records and native save checkpoint markers remain available. Inactive older overlays exclude known foreign geometry before native worker evaluation, relying on the existing final-owner-pure native packages for unresolved native endpoint IDs. Those older foreign cohorts appear in the cross viewer after their originating tile activates and migrates. An unknown owner or conflicting endpoint identity fails before publication.

Regression coverage uses the real growth engine and entry point, including native publication, pressure-only persistence, retirement, save holds during candidate reads, hot reload, older checkpoint selection, viewer revision/selection, asynchronous route fencing, and cheap settlement with both clock modes. Read-only captured-data measurements found 9,508 Hyogo ownership queries in approximately 30–33 ms. Foreign candidate preparation over 62,054 packaged points and 78,551 cohorts took 574 ms wall time in 40 slices (largest 7.51 ms); querying 1,408 served stations took 23 ms and performed no ownership or package reads. These are local source measurements, not a foreground game frame-time guarantee.

The runtime markers are `open-world-demand-v1-2026-10-06-v8-cross-tile-growth` and `open-world-induced-cross-demand-v1-2026-10-06`. The consumer code is shared by Japan and released NEC. Reload both Open World and Induced Demand to run this build; the currently executing renderer is not changed by replacing installed bundles. `__inducedDemand.status()` now includes compact ownership and cross-cohort/people counts.

Final checks pass 495 Induced Demand tests, 1,276 shared/KC tests, 7 Japan tests and 18 NEC tests, plus TypeScript and whitespace checks. The generated and installed bundles have matching markers, SHA-256 hashes and modification times:

| Installed mod | Bytes | SHA-256 |
| --- | ---: | --- |
| Induced Demand | 235,976 | `548B83D5FC5365F6DD9769A9BFB9D867852D8323141195B21A3F5A64DF0A47B1` |
| Japan Open World | 25,868,431 | `4D254B120C7D710D15704E56BF5FADEEBF21B534715CF5B993AD5C51DF296F7A` |
| Released NEC | 10,308,849 | `037E4B2E54E4C1D0DE8C399872B1F3781B1C797EF722D517A6F0B1491DC05E25` |

The previous bundles and manifests are backed up under `C:\Users\darkd\AppData\Local\Temp\induced-cross-tile-227670c3bc9047639f99ce8cbeda136b`, each in its exact mod-ID directory. Only the three installed `index.js` files were replaced. Native saves, city data, installed manifests and simulation preferences were not changed. Source/runtime tests and disk verification pass; live viewer and foreground game behavior await the user's reload.

## Dedicated induced-demand viewer row

The Cross-city demand panel now has an additional two-button row: **Induced Residents** and **Induced Workers**. It appears below Trips from/to when those views are available, and remains selectable with a zero induced bank. These views show only checkpoint-owned induced cross cohorts: dots, transport shares, counts, point details and connections exclude packaged commutes and one-way movements. The ordinary resident/worker views retain their combined totals.

Membership comes from the projected catalog's `extensionPopIds`. Subset indexes and global summaries are prepared once when the existing read model is built. Switching a view does not evaluate routes, read packages or simulate demand. Induced worker dots retain the native worker sizing curve and use inbound home endpoints in details.

The viewer marker is `induced-commuter-views-v3`. All 1,283 shared/KC tests, 7 Japan tests and 18 NEC tests pass. This includes mixed same-endpoint packaged/induced mass, one-way exclusion, empty banks, transport shares, inbound direction, lazy route loading and native dot sizing. Read-only integration review found no remaining issue.

Japan and released NEC were rebuilt and their exact installed `index.js` files replaced after backups. Japan is 25,871,314 bytes with SHA-256 `2F17B82A6C3DF79E6103F18E7619B232C6C06C876CB69FE84F607D996FBAFEAD`; NEC is 10,311,732 bytes with SHA-256 `25EE8EBBE70A09F0091252B16AE70FE22D47BAD4B81346DE72C6B5C95E14E1B3`. The previous files are under `C:\Users\darkd\AppData\Local\Temp\induced-viewer-row-ecf9dd2086d04515b8bdf4311d2fc37b`, separated by exact mod ID. Induced Demand itself did not change. Reload Open World to activate the new row; live screen verification follows that reload.

This UI follow-up is on `codex/induced-demand-viewer-row`.
