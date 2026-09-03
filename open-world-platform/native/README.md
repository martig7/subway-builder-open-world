# Subway Builder Open World Windows installer and tile server

This directory contains the native Windows release path shared by Open World
consumers. Setup reads one signed release catalog and lets the user choose which
World to install.

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

## Release

The release command always builds Northeast Corridor and can also include
Tokyo–Kanagawa. Each release build replaces only its packaged manifest identity,
verifies the requested semantic version, and declares
`dependencies.subway-builder`; each JavaScript bundle remains the same consumer
build used by its development mod.

```powershell
./scripts/Publish-OpenWorldWindowsRelease.ps1 `
  -Version 0.1.0 `
  -ReleaseAssetBaseUrl https://github.com/OWNER/REPO/releases/download/v0.1.0 `
  -NecModRoot ../../../prototype/nec-corridor/mod `
  -NecTileRoot ../../../prototype/nec-corridor/generated/mod/tiles `
  -TokyoModRoot ../../../prototype/tokyo-kanagawa/mod `
  -TokyoTileRoot ../../../prototype/tokyo-kanagawa/generated/mod/tiles `
  -Output ../../../prototype/nec-corridor/generated/release/v0.1.0
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
