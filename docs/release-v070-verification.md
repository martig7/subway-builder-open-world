# v0.7.0 release verification

The release remains **draft** pending the user's review and explicit publication
request. The initial release branch is `codex/release-v070`; the demand-viewer
correction is on `codex/nec-cross-demand-view-modes`, implementation commit
`ecb195e`. The draft incorporates this correction in both consumer bundles and
the signed installer catalogs.
Save reload and naming fixes follow on `codex/save-reload-and-naming`,
implementation commit `347f06d`.

## Packaged worlds

| World | Release manifest ID | Consumer | Tiles | Map ZIPs | Download |
| --- | --- | --- | ---: | ---: | ---: |
| Northeast Corridor | `northeast-corridor-open-world` | `prototype/nec-corridor/mod` | 59 | 8 | 5.44 GiB |
| Japan | `local.japan-open-world` | `prototype/japan/mod` | 47 | 12 | 11.4 GiB |

The NEC development identity is `local.nec-corridor-open-world`; release packaging
retains the established `northeast-corridor-open-world` identity. Japan retains its
existing manifest/save identity. Both release consumers were rebuilt at 0.7.0
from the shared platform. Their bundles contain `runtime-audit-game-1.7.2-v1` and
`native-saved-reload-v7`. No geography or demand generation was run for packaging.
Map ZIPs remain below the 1.9 GB packaging budget and have bounded tile allowlists.

## Local checks

- 1,144 platform/Kansas City regression tests pass.
- 18 NEC consumer tests and 7 Japan consumer tests pass.
- 43 Windows/native tests pass, including an actual WPF **Check for updates**
  button invocation from a 0.6.0 manifest to the 0.7.0 candidate.
- The Mac backend suite passes locally: signed catalog/version agreement,
  replacement of manual installations, both-world installation, cancellation,
  rollback, corruption/repair, and uninstall preserving saves and other worlds.
  The shared update checks also pass; native Mac service/UI checks run in CI.
- Full Windows installs of the real signed payload pass for both worlds,
  including cancellation/resume. Installed manifests and bundles match the
  selected release archives and contain the current runtime marker.
- The packaged Windows server returns HTTP 200, the expected
  `X-PMTiles-Server-Version: native-pmtiles-directory-v4` and build 0.7.0,
  with 59 archives after NEC and 106 after adding Japan.

Windows installation tests use an isolated workspace scratch root and an
available test port. They do not replace the user's game installation. The test
process owns and stops its own server, and removes its scratch installation.
An in-game v0.7.0 playtest is left for the user's draft review.

## Demand-viewer correction

The panel now offers **Trips from** and **Trips to** only when the loaded
cross-tile demand contains positive-mass one-way trips. Commute-only demand keeps
**Residents** and **Workers**. This is based on demand records, so NEC gains the
trip buttons automatically when qualifying data becomes available. Reloading
commute-only data after a trip view resets the view to Residents.

Regression tests cover the global panel, point details, zero-mass trips,
unavailable mode selection, preservation of Japan's trip modes, and reload from
one-way to commute-only demand. Checks using the real generated New York and
Tokyo packages confirm two buttons for NEC (zero one-way movements) and all four
for Japan (7,815,206 one-way movements).

The rebuilt NEC release consumer `northeast-corridor-open-world` was installed
from `prototype/nec-corridor/mod/dist`. Its installed bundle matches the built
SHA-256 and timestamp and contains `available-trip-views-v2`. The shared local
service returns HTTP 200 with `native-pmtiles-directory-v4` and 106 archives.
The game was closed, so executing the new bundle in a live renderer remains a
user review step. Japan's local installation was not replaced.

Both release mod ZIPs were refreshed without regenerating or replacing map
archives. Catalog byte counts and hashes were recalculated, the catalog was
signed with the existing publisher certificate, and setup was rebuilt.
The refreshed Windows payload passed full NEC and Japan cancellation/resume
installation checks, bundle equality checks, and healthy service checks with
59 and then 106 archives. All 43 native tests also pass, including local
0.6.0-to-0.7.0 update discovery and the Windows manager's update button.

## Save reload and naming fixes

The native adapter reported `trainsOutOfService` correctly, but the World runtime
discarded it from the render revisions. Direct renderer tests passed while the
actual adapter-to-World-to-renderer path kept both train passes visible. The
runtime now forwards this boolean. Native pause and native Ultra speed remain
separate from cached mode's train visibility. Regression coverage replaces a
save session and render layers, then verifies that disabling cached mode
restores both train passes.

The movement guard advances to generation 37. Its hot-reload regression verifies
that attachment replaces both the previous patch object and wrapper function.
Train inventory, positions and saved data are not changed by this rendering fix.

New experimental autosaves use the native service's local-time format,
`[Auto] YYYY-MM-DD_HH-MM-SS`, instead of exposing the transport as "Tile server".
A fixed-clock regression checks the exact name and zero-padding. Existing saved
files are not renamed.

Both symptom tests failed before the corrections and pass afterward. The full
1,144-test platform suite, 18 NEC tests and 7 Japan tests pass. The installed
NEC bundle matches its build hash and timestamp and contains guard generation
37 and `tile-save-controller-v9`. Its local service is healthy. The game was
closed, so the live save-reload reproduction remains part of the user's review.
The refreshed signed Windows payload also passes full NEC and Japan
cancellation/resume installs, exact bundle verification, and service health
with 59 and then 106 archives. All 43 native tests pass, including real loopback
update discovery from 0.6.0 to 0.7.0 and the Windows manager's update button.

## Update discovery before publication

Both managers use the shared stable-release checker. Normal launches query
GitHub's public `/releases/latest`. Drafts and prereleases are excluded; current
or older releases do not prompt, and invalid/network responses remain errors.
The Mac manager now performs a version check instead of only opening the
releases list. Updates offer a release page rather than silently installing it.

`node tools/preview-release-update.mjs` serves candidate metadata at
`http://127.0.0.1:8193/releases/latest`. An explicitly set
`OPEN_WORLD_UPDATE_TEST_URL` opts a test manager into that HTTP loopback endpoint.
This models GitHub's post-publication response without exposing the real draft
or bypassing signed asset hashes. Both native suites test actual local HTTP
discovery from 0.6.0 to 0.7.0, release eligibility, errors and cancellation.

The Mac workflow also starts this local source and checks the running native
app/backend interaction. A 0.7.0 app reports that it is current against the
0.7.0 preview. Remove the environment override and stop the preview after use.

## Signing and release assets

Windows setup and the tile server retain publisher certificate
`9DB8A8264136088D1D891EF47068AB5C05843844` and a DigiCert timestamp. Windows reports
the self-signed root as untrusted. The private key stays in the Windows
certificate store; only the public certificate is shipped. Mac apps are ad-hoc
signed, not Apple Developer ID signed or notarized.

The Mac application embeds the same exact signed catalog as Windows setup.
Patch notes follow the published v0.6.0 format: **Download and install**, then
**What's new**, with end-user bullets and compact signing/checksum details.

## Final Mac verification

[Full workflow 37039916404](https://github.com/martig7/subway-builder-open-world/actions/runs/37039916404)
passed on Apple Silicon and Intel. Both jobs downloaded the actual draft assets,
built and mounted their DMG, installed and hash-verified both real worlds,
checked the packaged service, verified uninstall, and passed the running app's
local update check. This full-payload run preceded the demand-viewer correction.

Apple Silicon tested the real worlds sequentially because the hosted runner
could not retain both while satisfying the installer's staging/rollback space
requirements. It verified healthy services with 59 NEC and 47 Japan packages.
Intel verified real coexistence: 59 packages after NEC, then 106 after Japan,
and uninstall preserving the remaining world. Both architectures also pass
the multi-world safety fixtures.

After the demand-viewer correction,
[workflow 37061045012](https://github.com/martig7/subway-builder-open-world/actions/runs/37061045012)
rebuilt both architectures using the refreshed signed envelope. Both jobs
mounted the new DMGs and passed installer safety, service lifecycle, live
interface/backend and local update checks. These outputs verified the
demand-viewer correction. This follow-up did not redownload the unchanged full
map payload; the original full Mac run and refreshed full Windows run cover it.

For the save reload and naming fixes,
[workflow 37066968665](https://github.com/martig7/subway-builder-open-world/actions/runs/37066968665)
rebuilt and verified both architectures against the latest signed envelope.
Installer safety, service lifecycle, live interface and local update checks
passed. These exact DMGs are now attached to the draft. The map payload and
native installer behavior are unchanged.

The first full Apple Silicon attempt correctly stopped at Japan's disk-space
guard. The CI fixture had underestimated the peak space needed when retaining
NEC. Commit `777518a` bases the test's capacity decision on the Mac installer's
reported requirements. Limited-disk CI runs also remove the exact verified
mirror ZIPs after testing/uninstalling a world, freeing space for the next world.
Production space safeguards and installers were unchanged. The repaired full
workflow passed; the earlier interface/update workflow
[37031727241](https://github.com/martig7/subway-builder-open-world/actions/runs/37031727241)
also passed both architectures.

## Final assets

The draft contains 37 assets. All 36 checksum entries match GitHub's uploaded
SHA-256 digests; the checksum file itself is also verified. All 24 signed-catalog
assets match their declared byte sizes and SHA-256 values. The signed catalog
and its embedded Mac envelope agree. The local audit receipt is
`.analysis/v070-final-receipt.json` and remains Git-ignored.

| Installer | SHA-256 |
| --- | --- |
| Windows Setup | `6c8334e934db1237183f7b7f8ca185223a9dce81a14c786fbbf00a3d20a25823` |
| Apple Silicon DMG | `bec69ff5a67572fadefe5956d56b290301bfc0c2abb05de82b81a13cf1cf9f0f` |
| Intel DMG | `68a591204f9740d60b4d1e5f27a7ffc7ef037d817628819b4939f03480166ad0` |

[Draft release in GitHub's release list](https://github.com/martig7/subway-builder-open-world/releases).
Normal public update checks continue to see v0.6.0 until the user publishes
v0.7.0 as a stable release. No publication command was run.
