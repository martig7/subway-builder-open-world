# v0.7.0 release verification

The release remains **draft** pending the user's review and explicit publication
request. The release source is `449ccd505045211e1d06d4de0b7cf9d8d44e86d0` on
`codex/release-v070`; later documentation commits do not change the installers.

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

- 1,140 platform/Kansas City regression tests pass.
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

Final Mac workflow and uploaded-asset verification results will be appended
after the draft uploads and CI finish.
