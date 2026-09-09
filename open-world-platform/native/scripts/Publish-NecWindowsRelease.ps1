[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ReleaseAssetBaseUrl,
    [Parameter(Mandatory = $true)][Alias('ModRoot')][string]$NecModRoot,
    [Parameter(Mandatory = $true)][Alias('TileRoot')][string]$NecTileRoot,
    [string]$JapanModRoot,
    [string]$JapanTileRoot,
    [string]$TokyoModRoot,
    [string]$TokyoTileRoot,
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidatePattern('^https?://')][string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$versionPath = Join-Path $repositoryRoot 'VERSION'
if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) { throw "Open World version file is missing: $versionPath" }
$Version = [System.IO.File]::ReadAllText($versionPath).Trim()
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid Open World version: $Version" }
if (-not $ReleaseAssetBaseUrl.TrimEnd('/').EndsWith("/v$Version", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "ReleaseAssetBaseUrl must end in /v$Version."
}
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
if ([string]::IsNullOrWhiteSpace($JapanModRoot) -ne [string]::IsNullOrWhiteSpace($JapanTileRoot)) { throw 'JapanModRoot and JapanTileRoot must be supplied together.' }
$resolvedJapanModRoot = if ($JapanModRoot) { [System.IO.Path]::GetFullPath($JapanModRoot) } else { $null }
$resolvedJapanTileRoot = if ($JapanTileRoot) { [System.IO.Path]::GetFullPath($JapanTileRoot) } else { $null }
if ($resolvedJapanModRoot -and -not (Test-Path -LiteralPath $resolvedJapanModRoot -PathType Container)) { throw "Japan mod source directory is missing: $resolvedJapanModRoot" }
if ($resolvedJapanTileRoot -and -not (Test-Path -LiteralPath $resolvedJapanTileRoot -PathType Container)) { throw "Japan tile package directory is missing: $resolvedJapanTileRoot" }
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

$inferredArtifactsRoot = Split-Path -Parent (Split-Path -Parent $resolvedTileRoot)
$expectedTileRoot = [System.IO.Path]::GetFullPath((Join-Path $inferredArtifactsRoot 'mod\tiles'))
$normalizedTileRoot = $resolvedTileRoot.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
if (-not [string]::Equals($expectedTileRoot, $normalizedTileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'TileRoot must be the generated mod\tiles directory so the matching consumer artifacts can be selected.'
}
$priorNecArtifactsRoot = $env:NEC_ARTIFACTS_ROOT
$priorNecPackagedTileRoot = $env:NEC_PACKAGED_TILE_ROOT
Push-Location $resolvedModRoot
try {
    $env:NEC_ARTIFACTS_ROOT = $inferredArtifactsRoot
    $env:NEC_PACKAGED_TILE_ROOT = $resolvedTileRoot
    npm run build:release
    if ($LASTEXITCODE -ne 0) { throw 'NEC release mod build failed.' }
} finally {
    if ($null -eq $priorNecArtifactsRoot) { Remove-Item Env:NEC_ARTIFACTS_ROOT -ErrorAction SilentlyContinue }
    else { $env:NEC_ARTIFACTS_ROOT = $priorNecArtifactsRoot }
    if ($null -eq $priorNecPackagedTileRoot) { Remove-Item Env:NEC_PACKAGED_TILE_ROOT -ErrorAction SilentlyContinue }
    else { $env:NEC_PACKAGED_TILE_ROOT = $priorNecPackagedTileRoot }
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
    $priorTokyoPackagedTileRoot = $env:TOKYO_KANAGAWA_PACKAGED_TILE_ROOT
    Push-Location $resolvedTokyoModRoot
    try {
        $env:TOKYO_KANAGAWA_ARTIFACTS_ROOT = $tokyoArtifactsRoot
        $env:TOKYO_KANAGAWA_PACKAGED_TILE_ROOT = $resolvedTokyoTileRoot
        npm run build:release
        if ($LASTEXITCODE -ne 0) { throw 'Tokyo–Kanagawa release mod build failed.' }
    } finally {
        if ($null -eq $priorTokyoArtifactsRoot) { Remove-Item Env:TOKYO_KANAGAWA_ARTIFACTS_ROOT -ErrorAction SilentlyContinue }
        else { $env:TOKYO_KANAGAWA_ARTIFACTS_ROOT = $priorTokyoArtifactsRoot }
        if ($null -eq $priorTokyoPackagedTileRoot) { Remove-Item Env:TOKYO_KANAGAWA_PACKAGED_TILE_ROOT -ErrorAction SilentlyContinue }
        else { $env:TOKYO_KANAGAWA_PACKAGED_TILE_ROOT = $priorTokyoPackagedTileRoot }
        Pop-Location
    }
    $resolvedTokyoModDist = Join-Path $resolvedTokyoModRoot 'dist'
}

if ($resolvedJapanModRoot) {
    $japanArtifactsRoot = Split-Path -Parent (Split-Path -Parent $resolvedJapanTileRoot)
    $expectedJapanTileRoot = [System.IO.Path]::GetFullPath((Join-Path $japanArtifactsRoot 'mod\tiles'))
    $normalizedJapanTileRoot = $resolvedJapanTileRoot.TrimEnd([char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
    if (-not [string]::Equals($expectedJapanTileRoot, $normalizedJapanTileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'JapanTileRoot must be the generated mod\tiles directory.'
    }
    $priorJapanArtifactsRoot = $env:JAPAN_ARTIFACTS_ROOT
    $priorJapanPackagedTileRoot = $env:JAPAN_PACKAGED_TILE_ROOT
    Push-Location $resolvedJapanModRoot
    try {
        $env:JAPAN_ARTIFACTS_ROOT = $japanArtifactsRoot
        $env:JAPAN_PACKAGED_TILE_ROOT = $resolvedJapanTileRoot
        npm run build:release
        if ($LASTEXITCODE -ne 0) { throw 'Japan–Kanagawa release mod build failed.' }
    } finally {
        if ($null -eq $priorJapanArtifactsRoot) { Remove-Item Env:JAPAN_ARTIFACTS_ROOT -ErrorAction SilentlyContinue }
        else { $env:JAPAN_ARTIFACTS_ROOT = $priorJapanArtifactsRoot }
        if ($null -eq $priorJapanPackagedTileRoot) { Remove-Item Env:JAPAN_PACKAGED_TILE_ROOT -ErrorAction SilentlyContinue }
        else { $env:JAPAN_PACKAGED_TILE_ROOT = $priorJapanPackagedTileRoot }
        Pop-Location
    }
    $resolvedJapanModDist = Join-Path $resolvedJapanModRoot 'dist'
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
    --expected-tiles 36 `
    --map-parts 4 `
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
        --map-parts 1 `
        --port 8799 `
        --manifest-name release-manifest-tokyo-kanagawa.json
    if ($LASTEXITCODE -ne 0) { throw 'Tokyo–Kanagawa release packaging failed.' }
}

if ($resolvedJapanModRoot) {
    dotnet run --project $packager -c Release -- `
        --mod-dist $resolvedJapanModDist `
        --tile-root $resolvedJapanTileRoot `
        --server-exe $serverExecutable `
        --output $resolvedOutput `
        --base-url $ReleaseAssetBaseUrl `
        --version $Version `
        --product-id 'Japan Open World' `
        --product-name 'Japan–Kanagawa Open World' `
        --manifest-id local.japan-open-world `
        --asset-prefix japan `
        --tile-prefix JP `
        --expected-tiles 47 `
        --map-parts 12 `
        --port 8799 `
        --manifest-name release-manifest-japan.json
    if ($LASTEXITCODE -ne 0) { throw 'Japan–Kanagawa release packaging failed.' }
}

$worldManifests = @((Get-Content -Raw -LiteralPath (Join-Path $resolvedOutput 'release-manifest-nec.json') | ConvertFrom-Json))
if ($resolvedTokyoModRoot) { $worldManifests += (Get-Content -Raw -LiteralPath (Join-Path $resolvedOutput 'release-manifest-tokyo-kanagawa.json') | ConvertFrom-Json) }
if ($resolvedJapanModRoot) { $worldManifests += (Get-Content -Raw -LiteralPath (Join-Path $resolvedOutput 'release-manifest-japan.json') | ConvertFrom-Json) }
$catalogPath = Join-Path $resolvedOutput 'release-catalog.json'
$releaseCatalog = [ordered]@{ schemaVersion = 1; version = $Version; worlds = $worldManifests }
[System.IO.File]::WriteAllText($catalogPath, ($releaseCatalog | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
$signaturePath = "$catalogPath.sig"
$certificatePath = Join-Path $resolvedOutput 'publisher.cer'
[void](Export-Certificate -Cert $certificate -FilePath $certificatePath -Force)
$rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
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

# The macOS app embeds the same exact signed catalog as Windows setup.
$envelope = [ordered]@{
    certificate = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($certificatePath))
    signature = [System.IO.File]::ReadAllText($signaturePath).Trim()
    catalog = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($catalogPath))
}
[System.IO.File]::WriteAllText((Join-Path $resolvedOutput 'release-envelope.json'), ($envelope | ConvertTo-Json -Compress) + [Environment]::NewLine)

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
    'Test release',
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
