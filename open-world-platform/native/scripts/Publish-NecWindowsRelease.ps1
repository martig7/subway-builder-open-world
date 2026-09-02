[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ReleaseAssetBaseUrl,
    [Parameter(Mandatory = $true)][Alias('ModRoot')][string]$NecModRoot,
    [Parameter(Mandatory = $true)][Alias('TileRoot')][string]$NecTileRoot,
    [string]$TokyoModRoot,
    [string]$TokyoTileRoot,
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidatePattern('^https?://')][string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$resolvedModRoot = [System.IO.Path]::GetFullPath($NecModRoot)
$resolvedTileRoot = [System.IO.Path]::GetFullPath($NecTileRoot)
$resolvedOutput = [System.IO.Path]::GetFullPath($Output)
if (-not (Test-Path -LiteralPath $resolvedModRoot -PathType Container)) { throw "Mod source directory is missing: $resolvedModRoot" }
if (-not (Test-Path -LiteralPath $resolvedTileRoot -PathType Container)) { throw "Tile package directory is missing: $resolvedTileRoot" }
if ([string]::IsNullOrWhiteSpace($TokyoModRoot) -ne [string]::IsNullOrWhiteSpace($TokyoTileRoot)) { throw 'TokyoModRoot and TokyoTileRoot must be supplied together.' }
$resolvedTokyoModRoot = if ($TokyoModRoot) { [System.IO.Path]::GetFullPath($TokyoModRoot) } else { $null }
$resolvedTokyoTileRoot = if ($TokyoTileRoot) { [System.IO.Path]::GetFullPath($TokyoTileRoot) } else { $null }
if ($resolvedTokyoModRoot -and -not (Test-Path -LiteralPath $resolvedTokyoModRoot -PathType Container)) { throw "Tokyo mod source directory is missing: $resolvedTokyoModRoot" }
if ($resolvedTokyoTileRoot -and -not (Test-Path -LiteralPath $resolvedTokyoTileRoot -PathType Container)) { throw "Tokyo tile package directory is missing: $resolvedTokyoTileRoot" }
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

$inferredArtifactsRoot = Split-Path -Parent (Split-Path -Parent $resolvedTileRoot)
$expectedTileRoot = [System.IO.Path]::GetFullPath((Join-Path $inferredArtifactsRoot 'mod\tiles'))
$normalizedTileRoot = $resolvedTileRoot.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
if (-not [string]::Equals($expectedTileRoot, $normalizedTileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'TileRoot must be the generated mod\tiles directory so the matching consumer artifacts can be selected.'
}
$priorNecArtifactsRoot = $env:NEC_ARTIFACTS_ROOT
Push-Location $resolvedModRoot
try {
    $env:NEC_ARTIFACTS_ROOT = $inferredArtifactsRoot
    npm run build:release -- --version $Version
    if ($LASTEXITCODE -ne 0) { throw 'NEC release mod build failed.' }
} finally {
    if ($null -eq $priorNecArtifactsRoot) { Remove-Item Env:NEC_ARTIFACTS_ROOT -ErrorAction SilentlyContinue }
    else { $env:NEC_ARTIFACTS_ROOT = $priorNecArtifactsRoot }
    Pop-Location
}
$resolvedModDist = Join-Path $resolvedModRoot 'dist'

if ($resolvedTokyoModRoot) {
    $tokyoArtifactsRoot = Split-Path -Parent (Split-Path -Parent $resolvedTokyoTileRoot)
    $expectedTokyoTileRoot = [System.IO.Path]::GetFullPath((Join-Path $tokyoArtifactsRoot 'mod\tiles'))
    $normalizedTokyoTileRoot = $resolvedTokyoTileRoot.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
    if (-not [string]::Equals($expectedTokyoTileRoot, $normalizedTokyoTileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'TokyoTileRoot must be the generated mod\tiles directory.'
    }
    $priorTokyoArtifactsRoot = $env:TOKYO_KANAGAWA_ARTIFACTS_ROOT
    Push-Location $resolvedTokyoModRoot
    try {
        $env:TOKYO_KANAGAWA_ARTIFACTS_ROOT = $tokyoArtifactsRoot
        npm run build:release -- --version $Version
        if ($LASTEXITCODE -ne 0) { throw 'Tokyo–Kanagawa release mod build failed.' }
    } finally {
        if ($null -eq $priorTokyoArtifactsRoot) { Remove-Item Env:TOKYO_KANAGAWA_ARTIFACTS_ROOT -ErrorAction SilentlyContinue }
        else { $env:TOKYO_KANAGAWA_ARTIFACTS_ROOT = $priorTokyoArtifactsRoot }
        Pop-Location
    }
    $resolvedTokyoModDist = Join-Path $resolvedTokyoModRoot 'dist'
}

$certificate = & (Join-Path $PSScriptRoot 'Get-OrCreateSelfSignedCertificate.ps1')
if (-not $certificate.HasPrivateKey) { throw 'The self-signed release certificate has no private key.' }

$buildRoot = Join-Path $resolvedOutput '.build'
$serverPublish = Join-Path $buildRoot 'server'
$setupPublish = Join-Path $buildRoot 'setup'
New-Item -ItemType Directory -Force -Path $serverPublish, $setupPublish | Out-Null
$serverProject = Join-Path $nativeRoot 'src\OpenWorld.TileServer\OpenWorld.TileServer.csproj'
dotnet publish $serverProject -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:PublishTrimmed=true -p:InvariantGlobalization=true `
    -o $serverPublish
if ($LASTEXITCODE -ne 0) { throw 'Tile-server publish failed.' }
$serverExecutable = Join-Path $serverPublish 'open-world-tile-server.exe'
$serverSignature = Set-AuthenticodeSignature -LiteralPath $serverExecutable -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $TimestampServer
if (-not $serverSignature.SignerCertificate -or $serverSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'The tile-server executable was not signed by the release certificate.'
}

$packager = Join-Path $nativeRoot 'src\OpenWorld.ReleasePackager\OpenWorld.ReleasePackager.csproj'
dotnet run --project $packager -c Release -- `
    --mod-dist $resolvedModDist `
    --tile-root $resolvedTileRoot `
    --server-exe $serverExecutable `
    --output $resolvedOutput `
    --base-url $ReleaseAssetBaseUrl `
    --version $Version `
    --manifest-name release-manifest-nec.json
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }

if ($resolvedTokyoModRoot) {
    dotnet run --project $packager -c Release -- `
        --mod-dist $resolvedTokyoModDist `
        --tile-root $resolvedTokyoTileRoot `
        --server-exe $serverExecutable `
        --output $resolvedOutput `
        --base-url $ReleaseAssetBaseUrl `
        --version $Version `
        --product-id 'Tokyo Kanagawa Open World' `
        --product-name 'Tokyo–Kanagawa Open World' `
        --manifest-id tokyo-kanagawa-open-world `
        --asset-prefix tokyo-kanagawa `
        --tile-prefix JP `
        --expected-tiles 2 `
        --port 8800 `
        --manifest-name release-manifest-tokyo-kanagawa.json
    if ($LASTEXITCODE -ne 0) { throw 'Tokyo–Kanagawa release packaging failed.' }
}

$worldManifests = @((Get-Content -Raw -LiteralPath (Join-Path $resolvedOutput 'release-manifest-nec.json') | ConvertFrom-Json))
if ($resolvedTokyoModRoot) { $worldManifests += (Get-Content -Raw -LiteralPath (Join-Path $resolvedOutput 'release-manifest-tokyo-kanagawa.json') | ConvertFrom-Json) }
$catalogPath = Join-Path $resolvedOutput 'release-catalog.json'
$releaseCatalog = [ordered]@{ schemaVersion = 1; version = $Version; worlds = $worldManifests }
[System.IO.File]::WriteAllText($catalogPath, ($releaseCatalog | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
$signaturePath = "$catalogPath.sig"
$certificatePath = Join-Path $resolvedOutput 'publisher.cer'
[void](Export-Certificate -Cert $certificate -FilePath $certificatePath -Force)
$rsa = $certificate.GetRSAPrivateKey()
try {
    $manifestBytes = [System.IO.File]::ReadAllBytes($catalogPath)
    $manifestSignature = $rsa.SignData(
        $manifestBytes,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    [System.IO.File]::WriteAllText($signaturePath, [Convert]::ToBase64String($manifestSignature) + [Environment]::NewLine)
} finally {
    $rsa.Dispose()
}

$setupProject = Join-Path $nativeRoot 'src\OpenWorld.Installer\OpenWorld.Installer.csproj'
dotnet publish $setupProject -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
    "-p:ReleaseCatalogPath=$catalogPath" `
    "-p:ReleaseCatalogSignaturePath=$signaturePath" `
    "-p:PublisherCertificatePath=$certificatePath" `
    -o $setupPublish
if ($LASTEXITCODE -ne 0) { throw 'Installer publish failed.' }
$setupExecutable = Join-Path $setupPublish 'Subway-Builder-Open-World-Setup.exe'
$setupSignature = Set-AuthenticodeSignature -LiteralPath $setupExecutable -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $TimestampServer
if (-not $setupSignature.SignerCertificate -or $setupSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'The setup executable was not signed by the release certificate.'
}
Copy-Item -LiteralPath $setupExecutable -Destination (Join-Path $resolvedOutput 'Subway-Builder-Open-World-Setup.exe') -Force
$publishedSetup = Join-Path $resolvedOutput 'Subway-Builder-Open-World-Setup.exe'

function Format-ReleaseByteSize([long]$Bytes) {
    if ($Bytes -ge 1GB) { return '{0:0.00} GiB' -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return '{0:0.0} MiB' -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return '{0:0.0} KiB' -f ($Bytes / 1KB) }
    return "$Bytes bytes"
}

$setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $publishedSetup).Hash.ToLowerInvariant()
$spaceLines = foreach ($world in $worldManifests) {
    $downloadBytes = [long](($world.assets | Measure-Object -Property downloadBytes -Sum).Sum)
    "- $($world.product.name): $(Format-ReleaseByteSize $downloadBytes) download, $(Format-ReleaseByteSize ([long]$world.space.installedBytes)) installed, $(Format-ReleaseByteSize ([long]$world.space.requiredFreeBytes)) free space required"
}
$releaseBody = @(
    "# Subway Builder Open World $Version",
    '',
    '## Download',
    '',
    "Download exactly one file: [Subway-Builder-Open-World-Setup.exe]($($ReleaseAssetBaseUrl.TrimEnd('/'))/Subway-Builder-Open-World-Setup.exe) ($(Format-ReleaseByteSize (Get-Item -LiteralPath $publishedSetup).Length)).",
    '',
    'Choose a world in setup. It downloads and verifies only that mod, its map-data packages, and the tile-server executable.',
    '',
    '## Space required',
    ''
) + $spaceLines + @(
    '',
    'Setup shows every destination directory before it changes files and reports download, verification, installation, and tile-server startup progress.',
    '',
    '## Self-signed publisher',
    '',
    'The project self-signs both Windows executables. Windows may warn that the publisher is not trusted; this does not mean the files are unsigned.',
    '',
    ('- Certificate subject: `{0}`' -f $certificate.Subject),
    ('- Certificate thumbprint: `{0}`' -f $certificate.Thumbprint),
    ('- Setup SHA-256: `{0}`' -f $setupHash),
    '',
    'Compare these values with the release assets before running setup. `publisher.cer` contains the public certificate; the private key is never published.'
)
[System.IO.File]::WriteAllLines((Join-Path $resolvedOutput 'release-body.md'), $releaseBody)

$checksumLines = Get-ChildItem -LiteralPath $resolvedOutput -File |
    Where-Object Name -ne 'SHA256SUMS.txt' |
    Sort-Object Name |
    ForEach-Object { "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(), $_.Name }
[System.IO.File]::WriteAllLines((Join-Path $resolvedOutput 'SHA256SUMS.txt'), $checksumLines)

Write-Host "Created self-signed Subway Builder Open World release $Version"
Write-Host "Certificate thumbprint: $($certificate.Thumbprint)"
Write-Host "Output: $resolvedOutput"
