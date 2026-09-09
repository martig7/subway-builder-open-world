# Subway Builder Open World installer and tile server

This directory contains the native Windows release path shared by Open World
consumers. Setup reads one signed release catalog and lets the user choose which
World to install.

The tile server itself is cross-platform. `scripts/Publish-StandaloneTileServers.ps1`
produces self-contained Windows x64, macOS Apple Silicon, and macOS Intel ZIPs.
See `docs/manual-installation.md` for the temporary manual setup path.

Installed Worlds register their tile packages with one per-user PMTiles service
on port `8799`. Starting, repairing, or installing a World restarts that verified
service with the union of every registered World's tile IDs. Uninstalling one
World removes only its registration and packages, then hands the service to a
remaining installed manager when it was already running.

- `OpenWorld.Installer` is the WPF setup/manager executable.
- `OpenWorld.TileServer` is the independent loopback PMTiles server executable.
- `OpenWorld.Release` validates signed release manifests, downloads and verifies
  assets, and installs ZIPs into scoped per-user targets.
- `OpenWorld.ReleasePackager` produces one flat Railyard mod ZIP, one signed
  support package, and independently repairable data ZIPs for a selected World.

The public setup path does not invoke PowerShell. PowerShell is used only by the
maintainer-side release script to create/reuse a self-signed code-signing
certificate and sign the produced executables and release manifest.

## Development

```powershell
$env:DOTNET_CLI_HOME = Join-Path $env:TEMP 'nec-open-world-dotnet'
dotnet run --project tests/OpenWorld.Native.Tests/OpenWorld.Native.Tests.csproj -c Release
dotnet build src/OpenWorld.Installer/OpenWorld.Installer.csproj -c Release
```

Launching the normal development build without a signed release catalog opens
an interface preview containing Northeast Corridor and Tokyo–Kanagawa. Selecting
a World updates its measured size, destinations, package count, and server port.

To exercise a signed setup build without uploading its packaged assets, keep the
setup executable and generated assets together and open setup normally. It uses
the containing folder when every catalog asset is present. `--asset-root
<release-folder>` can select a different folder. Setup still enforces every size
and SHA-256 value from the signed release catalog.

## Release

The release command always builds Northeast Corridor and can also include
Tokyo–Kanagawa. Each release build replaces only its packaged manifest identity,
verifies the requested semantic version, and declares
`dependencies.subway-builder`; each JavaScript bundle remains the same consumer
build used by its development mod.

```powershell
./scripts/Publish-NecWindowsRelease.ps1 `
  -ReleaseAssetBaseUrl https://github.com/OWNER/REPO/releases/download/v0.6.0 `
  -NecModRoot ../../../prototype/nec-corridor/mod `
  -NecTileRoot ../../../prototype/nec-corridor/generated/mod/tiles `
  -JapanModRoot ../../../prototype/japan/mod `
  -JapanTileRoot ../../../prototype/japan/generated/mod/tiles `
  -Output ../../../prototype/nec-corridor/generated/release/v0.6.0
```

The first run creates a five-year RSA code-signing certificate in the current
user certificate store. The public certificate is exported as `publisher.cer`;
the private key is never written into the repository or release directory.
Windows will still describe the publisher as self-signed/untrusted unless the
user independently trusts that certificate. The release page must say this
plainly and publish the certificate thumbprint and SHA-256 checksums.

The script generates `release-body.md` with a single-file download instruction,
the setup executable's exact size and SHA-256, the additional download and disk
requirements, and the self-signed certificate identity. Use that generated text
for the GitHub release description.

To build standalone server packages using the repository's central version:

```powershell
./scripts/Publish-StandaloneTileServers.ps1 `
  -Output ../../../prototype/nec-corridor/generated/release/tile-server
```

The Windows binary is signed with the same self-signed publisher certificate as
setup. The placeholder macOS binaries are unsigned and must be signed and
notarized on macOS before they can provide a normal Gatekeeper experience.

### v0.6.0 verification before publication

Japan keeps manifest ID `local.japan-open-world`, including existing saves and
installed-world registration. Setup offers NEC and Japan independently. Both
use the shared service on port 8799. Stored native route indexes/binaries ship
with every tile; the world-wide cross-route archive ships with the initial tile.

The packager splits NEC into four ZIPs and Japan into twelve ZIPs and rejects a
part over 1.9 GB before compression. Every ZIP has a bounded tile allowlist and
recorded byte size/SHA-256. Packaging never regenerates geography or demand.

`release-envelope.json` contains only the signed catalog and public certificate,
using the same bytes embedded by Windows setup. Copy it into
`src/OpenWorld.MacBackend/release-envelope.json` before committing the candidate.
The macOS workflow can download it directly from a draft release by supplying
`release_tag: v0.6.0`; its GitHub token allows draft asset access. The workflow
builds/mounts the DMG and runs a full install, file verification, service health,
and uninstall for **every** catalog world on both Apple Silicon and Intel.
The local asset folder still requires catalog sizes and hashes; it bypasses no
verification. UI screenshots and diagnostics are retained as workflow artifacts.

Windows real-asset verification uses an isolated fresh scratch directory:

```powershell
dotnet run --project tests/OpenWorld.Native.Tests -c Release -- `
  --release-smoke D:/OpenWorldReleases/v0.6.0 D:/OpenWorldReleases/smoke-v060
```

Keep the GitHub release draft pending an explicit publication request, even after
these checks pass. Neither workflow publishes
it automatically. macOS artifacts are ad-hoc signed, not notarized.

