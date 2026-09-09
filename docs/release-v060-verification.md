# v0.6.0 release verification

The release remains **draft**, including after these checks, pending an explicit publication request.

## Packaged worlds

| World | Stable manifest ID | Tiles | Map ZIPs | Download |
| --- | --- | ---: | ---: | ---: |
| Northeast Corridor | `northeast-corridor-open-world` | 36 | 4 | 3.96 GiB |
| Japan | `local.japan-open-world` | 47 | 12 | 7.40 GiB |

Japan keeps its existing installation/save identity. Both worlds include stored native driving-route archives for every tile and their world-wide cross-tile archive in the initial tile. No geography was regenerated for release packaging. ZIPs are checked against the 1.9 GB packaging budget and have scoped tile allowlists. All 20 catalog assets matched GitHub's uploaded byte size and SHA-256 digest.

## Verification

- 20 native Windows installer safety tests passed.
- 9 Mac backend safety scenarios passed locally with the signed 0.6.0 catalog.
- 6 Japan consumer tests passed.
- Windows full real-payload install and cancellation/resume passed for both worlds (36 NEC tiles, 47 Japan tiles). Both signed setup selection screens were inspected.
- [Full macOS workflow 34310696780](https://github.com/martig7/subway-builder-open-world/actions/runs/34310696780) passed on Apple Silicon and Intel. Each runner downloaded the actual draft payload, mounted the DMG, installed and hash-verified NEC, verified the 36-tile service, installed Japan alongside NEC, verified the 83-tile service, and uninstalled while preserving the remaining world. The live UI showed both world choices.
- The workflow's read-only token initially could not see draft assets. After explicit user approval, `contents: write` is scoped to the verification job solely for draft access. The workflow contains no release publication commands. A metadata-only probe proved access before the full payload run.

The draft uses authenticated downloads followed by the installer's verified local asset mode. Public release URLs are not accessible until publication. Windows executables are self-signed using certificate `9DB8A8264136088D1D891EF47068AB5C05843844`; Mac apps are ad-hoc signed and not notarized. CI does not exercise a real user's Gatekeeper approval or Login Items consent.

## Installer hashes

| Installer | SHA-256 |
| --- | --- |
| Windows Setup | `6e5828be66212d2813ebb0b9056b254f898d4ff7da20b040e1b86873a820c1fc` |
| macOS Apple Silicon DMG | `9a46cc3f019532d87a13dbd0cf9bfea7a634d5e36f43d74751c4057d721d455c` |
| macOS Intel DMG | `15297f6ea3ded401929a12e735bdd3b78d4ac47fc7498d9a04f9a6f85e30a697` |

The DMGs come from the successful full-payload workflow. Adding them and refreshing release notes/checksums does not change any signed catalog, map ZIP, or Windows setup hash.

Final draft: https://github.com/martig7/subway-builder-open-world/releases/tag/untagged-2aec8c720f7eb8b19cea

All 33 release assets are uploaded, including both verified Mac DMGs. Every entry in the final checksum file matches GitHub's asset digest; all 20 signed catalog assets also match their declared size. The release was rechecked as draft after the final notes and asset updates.

## September 9 expense bugfix refresh

The draft was updated from `codex/release-v060-expense-fix` to include the
cached-simulation billing fixes through `dbc045e`. Both NEC and Japan now contain
`open-world-cached-simulation-v6`, including preservation of train billing
intervals across network edits. The mod archives' `index.js` files match their
consumer builds exactly. World definitions, map ZIPs and support archives remain
unchanged; diagnostic `__spikeProbe` instrumentation is absent from both bundles.

Refreshed both mod ZIPs, the per-world manifests, signed catalog and envelope,
Windows setup, and both Mac DMGs. The embedded Mac catalog is also committed.
The existing publisher certificate verified the new catalog signature. All 20
Windows installer safety tests and 9 local Mac backend safety scenarios passed.
The runtime fix separately passed 733 platform and 24 consumer tests and the
live NEC regression documented in `tile-switch-cached-expenses.md`.

[Mac workflow 34386171527](https://github.com/martig7/subway-builder-open-world/actions/runs/34386171527)
passed on Apple Silicon and Intel, including full NEC/Japan payload installation,
verification, lifecycle tests and UI checks. These runs produced the replacement
DMGs. No new full-payload Windows installation was run for this refresh; its
installer safety tests and signed catalog were checked locally, and the unchanged
map packages retain the earlier full Windows verification.

Current installer hashes (superseding the initial-build hashes above):

| Installer | SHA-256 |
| --- | --- |
| Windows Setup | `6e3355c32059c091de15315c13d438104b24d2e059eaa16411576c1632ffc24e` |
| macOS Apple Silicon DMG | `aac6a3c9fad3664014aad61b977c21eacfbd94cb7b54de1e76408062ee0cd159` |
| macOS Intel DMG | `62c3d557a4286e41b562c849f59639d32e3d9cbe0107850e1dc9823b1dde5895` |

All 32 checksum entries match the 33 uploaded assets (the checksum file excludes
itself). All 20 catalog assets match their uploaded size and digest. Existing
user-edited release notes were preserved and one end-user expense-fix bullet was
added. The release remains **draft**, targeting `codex/release-v060-expense-fix`.
The local audit receipt is `.analysis/v060-expense/final-receipt.json`.
