[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidatePattern('^https?://')][string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $nativeRoot '..\..'))
$version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'VERSION') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Invalid release version: $version" }

$resolvedOutput = [System.IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$buildRoot = Join-Path $resolvedOutput '.standalone-build'
$project = Join-Path $nativeRoot 'src\OpenWorld.TileServer\OpenWorld.TileServer.csproj'
$manual = Join-Path $repositoryRoot 'docs\manual-installation.md'
if (-not (Test-Path -LiteralPath $manual -PathType Leaf)) { throw "Manual installation guide is missing: $manual" }
$certificate = & (Join-Path $PSScriptRoot 'Get-OrCreateSelfSignedCertificate.ps1')
if (-not $certificate.HasPrivateKey) { throw 'The self-signed release certificate has no private key.' }

$targets = @(
    [pscustomobject]@{ Rid = 'win-x64'; Platform = 'windows-x64'; Executable = 'open-world-tile-server.exe'; Sign = $true },
    [pscustomobject]@{ Rid = 'osx-arm64'; Platform = 'macos-arm64'; Executable = 'open-world-tile-server'; Sign = $false },
    [pscustomobject]@{ Rid = 'osx-x64'; Platform = 'macos-x64'; Executable = 'open-world-tile-server'; Sign = $false }
)

$archives = [System.Collections.Generic.List[string]]::new()
try {
    foreach ($target in $targets) {
        $publishRoot = Join-Path $buildRoot (Join-Path 'publish' $target.Rid)
        $packageRoot = Join-Path $buildRoot (Join-Path 'package' $target.Platform)
        New-Item -ItemType Directory -Force -Path $publishRoot, $packageRoot | Out-Null

        dotnet publish $project -c Release -r $target.Rid --self-contained true `
            -p:PublishSingleFile=true -p:PublishTrimmed=true -p:InvariantGlobalization=true `
            -o $publishRoot
        if ($LASTEXITCODE -ne 0) { throw "Tile-server publish failed for $($target.Rid)." }

        $publishedExecutable = Join-Path $publishRoot $target.Executable
        if (-not (Test-Path -LiteralPath $publishedExecutable -PathType Leaf)) {
            throw "Published tile-server executable is missing for $($target.Rid): $publishedExecutable"
        }
        if ($target.Sign) {
            $signature = Set-AuthenticodeSignature -LiteralPath $publishedExecutable -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $TimestampServer
            if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
                throw 'The Windows tile-server executable was not signed by the release certificate.'
            }
        }

        Copy-Item -LiteralPath $publishedExecutable -Destination (Join-Path $packageRoot $target.Executable)
        @(
            "Open World Tile Server $version",
            "Platform: $($target.Platform)",
            '',
            'Follow MANUAL-INSTALLATION.md to copy the mod and maps into Subway Builder.',
            'To find the game folders, open the mod manager, click Open Mods Folder,',
            'then go up one folder level to metro-maker4.',
            '',
            "After extracting this ZIP, double-click $($target.Executable).",
            'Leave its window open while playing. Open it again before playing each time.',
            '',
            'One tile server handles all installed Open World maps.',
            'Do not open a second copy while one is running.'
        ) | Set-Content -LiteralPath (Join-Path $packageRoot 'README.txt') -Encoding utf8
        Copy-Item -LiteralPath $manual -Destination (Join-Path $packageRoot 'MANUAL-INSTALLATION.md')

        $archive = Join-Path $resolvedOutput "open-world-tile-server-$($target.Platform)-v$version.zip"
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
        Compress-Archive -Path (Join-Path $packageRoot '*') -DestinationPath $archive -CompressionLevel Optimal
        $archives.Add($archive)
    }

    $checksumPath = Join-Path $resolvedOutput 'tile-server-SHA256SUMS.txt'
    $archives | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $(Split-Path -Leaf $_)"
    } | Set-Content -LiteralPath $checksumPath -Encoding ascii

    Write-Host "Packaged $($archives.Count) standalone tile servers at $resolvedOutput"
    Get-Content -LiteralPath $checksumPath
}
finally {
    if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
}
