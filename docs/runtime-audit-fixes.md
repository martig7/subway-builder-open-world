# Runtime audit fixes — September 2026

The implementation audit focuses on the shared mod runtime. Tokyo–Kanagawa
(`local.tokyo-kanagawa-open-world`, `prototype/tokyo-kanagawa/mod`) is the
reference consumer for complex demand. Map creation and data processing were
not performance targets. The shared World Definition contract and build/install
workflow received the consistency changes identified by the codebase audit.

## Changes

| Finding | Implemented change |
| --- | --- |
| Recovery repeatedly generated and compressed a full native save | Forward the prior snapshot template into the game adapter; cancel recovery work that outlives gameplay or its guard. |
| Persistence cloned native state only to discard it | Select retained sidecar fields before cloning; settlement writes project their small journal directly. |
| Scalar UI reads copied population-level state | Use the active-tile getter and summary views; compute per-tile commute summaries in one pass. Notifications retain their event and summary-view arguments. |
| Cross-city calculations occupied the renderer | A session-owned worker routes and evaluates mode share. Unique fare requests are batched back to the native host to preserve authoritative fares. Transfer only routing catalog fields, excluding display geometry/LODs. Missing or failed workers use the synchronous implementation. |
| Bulk mode choice built inspector explanations | Share routing/formulas while preparing invariant field lookups once and constructing explanations only for inspection. |
| Driving access scanned every station | Reject unreachable exits first and query origin stations through the spatial index. |
| Hidden Deck layers still filtered geometry | Skip spatial work while hidden and invalidate cached membership so reappearing layers use fresh data. |
| Style events repeated style serialization and guard work | Coalesce each burst into one callback and use one layer snapshot for the range pass. |
| Removed markers retained state/listeners | Retire removed DOM and Marker references, including immediate add/remove cycles. |
| Disabled finance work still ran | Skip disabled expense inputs and defer native revenue inspection until explicitly requested or needed as a fallback. |
| Road queries reallocated graph-sized arrays | Reuse generation-tagged search arrays with weak ownership by the cached graph. |
| Session teardown left restart resources unavailable | Give route paths, workers, observers, invalidation, and overlays one session owner; recreate them on the next game. |
| Canonical topology created an empty projection overlay | Create that controller only for projection mode. |
| Consumer host fixtures drifted apart | Share the supported host state/actions and retain scenario-specific data and assertions. |
| JS and Python enforced different World contracts | Validate both against the canonical JSON Schema, retaining filesystem/catalog semantic checks. |
| Consumer build/install commands were inconsistent | Standardize `install:mod`, keeping build and dependency installation separate from deployment. |
| Builds/installs recopied unchanged large artifacts | Cache SHA-256 identities against path, size, mtime, and ctime; replace only changed/damaged assets. `--repair` rechecks and copies all managed assets. |
| World demand files were duplicated per tile | Store them once at the embedded package root; preserve historical standalone input compatibility. |

Hot-reload generations advance to Deck guard 12, geographic cleanup v4,
marker movement batch 2, and native recovery 5. Runtime diagnostics expose
`runtimeAuditVersion: 'runtime-audit-2026-09-v1'` and worker evaluation/fallback
counters through `crossModeShareWorker()`.

## Performance evidence

These are isolated measurements, not game FPS or an end-to-end startup claim.

| Workload | Before | After |
| --- | ---: | ---: |
| Tokyo cross-demand, synchronous calculation | 67.17 ms | 55.50 ms, with production execution moved to a worker |
| Tokyo-sized full view versus summary view | 10.33 ms | 0.089 ms |
| Tokyo demand plus 1,000 distant stations, distance calls | 8,945,937 | 8,937 |
| Same unreachable-destination stress case | 2,035 ms | 79 ms |
| Hidden 100,000-record update | approximately 10 ms in the audit | 0.0167 ms median, zero geometry reads |

Prior and optimized implementations produced identical modes and transit
journeys for 4,800 randomized cohorts across 60 stations, six routes, 12
departure contexts, and driving access enabled/disabled. Worker tests cover
structured-clone transport, native fare attribution, crashes, and disposal.
Road workspace reuse retains approximately 16 bytes per node while a graph is
cached, and releases that storage with the graph.

## Verification

Final validation: 571 platform tests, 13 Tokyo tests, 17 NEC tests, 20 New York
tests, four Japan tests, 19 native tests, and five Python contract/pipeline tests
passed. The release packager builds with zero warnings. Run the suites from
their respective package directories; Python uses the dependency declared in
`map-creator/pyproject.toml`.

For renderer integration, extract the MapLibre and index modules from the
installed game's `resources/app.asar` with `tools/inspect-asar.mjs`, then run:

```powershell
node open-world-platform/scripts/test-renderer-lifecycle-browser.mjs <maplibre.js> <index.js> <playwright/index.mjs>
```

This loads the game's MapLibre implementation in an isolated headless browser.
It verifies that 50 style events schedule one callback and one style snapshot,
and removing 100 real markers leaves no retained marker elements or native
movement listeners. It does not launch Subway Builder.

The native save/lifecycle harness uses that same extracted game index:

```powershell
node open-world-platform/scripts/test-native-game-bundle.mjs <index.js>
```

It runs the existing NEC lifecycle assertions with the shipped save generator,
nonempty demand compression, selected native setters, and native hook
registration/dispatch. It checks recovery reuse, observational save echoes,
restart invalidation, and hook disposal. Peripheral services and native save
schema validation are explicitly stubbed; the game application is never
initialized.

The user's request excludes opening the game. Extracted-bundle checks therefore
cover the host interactions, while a live renderer reload, clean in-game
diagnostic capture, and gameplay FPS remain unverified.

## Delivered bundle

The Tokyo consumer was rebuilt and its bundle installed in
`%APPDATA%/metro-maker4/mods/tokyo-kanagawa-open-world`. Built and installed
`index.js` match in timestamp, diagnostic markers, and SHA-256:
`c3fc913eaf21eff41c85aff7b1b848497a946d872f0c620daaa1e04801550ba2`.

This installation copied only the consumer's bundle files. Japan's official
shared server already owns and serves the installed Tokyo/Kanagawa city
packages, so those packages and registrations were preserved. After copying,
`/_health` and the configured Tokyo tile returned HTTP 200 with
`X-PMTiles-Server-Version: native-pmtiles-directory-v4`; the same server process
remained running. The general incremental installer is covered by temporary
installation tests, including replacement ordering, corruption repair, scoped
cleanup, and shared tile-list changes.
