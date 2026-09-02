# NEC Windows installer and tile server

This directory contains the native Windows release path for the Northeast
Corridor consumer:

- `OpenWorld.Installer` is the WPF setup/manager executable.
- `OpenWorld.TileServer` is the independent loopback PMTiles server executable.
- `OpenWorld.Release` validates signed release manifests, downloads and verifies
  assets, and installs ZIPs into scoped per-user targets.
- `OpenWorld.ReleasePackager` produces one flat Railyard mod ZIP, one signed
  support package, and 34 independently repairable data ZIPs.

The public setup path does not invoke PowerShell. PowerShell is used only by the
maintainer-side release script to create/reuse a self-signed code-signing
certificate and sign the produced executables and release manifest.

## Development

```powershell
$env:DOTNET_CLI_HOME = Join-Path $env:TEMP 'nec-open-world-dotnet'
dotnet run --project tests/OpenWorld.Native.Tests/OpenWorld.Native.Tests.csproj -c Release
dotnet build src/OpenWorld.Installer/OpenWorld.Installer.csproj -c Release
```

Launching the normal development build without a signed release manifest opens
a non-destructive interface preview. It displays the current measured NEC data
size and all 34 destination directories, but its progress run does not download
or install files.

## Release

The release command builds the NEC consumer and replaces only its packaged
manifest identity with `northeast-corridor-open-world`. It also verifies the
requested semantic version and declares `dependencies.subway-builder`; the
JavaScript bundle remains the same consumer build used by the development mod.

```powershell
./scripts/Publish-NecWindowsRelease.ps1 `
  -Version 0.1.0 `
  -ReleaseAssetBaseUrl https://github.com/OWNER/REPO/releases/download/v0.1.0 `
  -ModRoot ../../../prototype/nec-corridor/mod `
  -TileRoot ../../../prototype/nec-corridor/generated/mod/tiles `
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
