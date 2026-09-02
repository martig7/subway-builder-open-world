[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ReleaseAssetBaseUrl,
    [Parameter(Mandatory = $true)][string]$ModRoot,
    [Parameter(Mandatory = $true)][string]$TileRoot,
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidatePattern('^https?://')][string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$nativeRoot = Split-Path -Parent $PSScriptRoot
$resolvedModRoot = [System.IO.Path]::GetFullPath($ModRoot)
$resolvedTileRoot = [System.IO.Path]::GetFullPath($TileRoot)
$resolvedOutput = [System.IO.Path]::GetFullPath($Output)
if (-not (Test-Path -LiteralPath $resolvedModRoot -PathType Container)) { throw "Mod source directory is missing: $resolvedModRoot" }
if (-not (Test-Path -LiteralPath $resolvedTileRoot -PathType Container)) { throw "Tile package directory is missing: $resolvedTileRoot" }
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
$serverExecutable = Join-Path $serverPublish 'nec-tile-server.exe'
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
    --version $Version
if ($LASTEXITCODE -ne 0) { throw 'Release packaging failed.' }

$manifestPath = Join-Path $resolvedOutput 'release-manifest.json'
$signaturePath = "$manifestPath.sig"
$certificatePath = Join-Path $resolvedOutput 'publisher.cer'
[void](Export-Certificate -Cert $certificate -FilePath $certificatePath -Force)
$rsa = $certificate.GetRSAPrivateKey()
try {
    $manifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)
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
    "-p:ReleaseManifestPath=$manifestPath" `
    "-p:ReleaseSignaturePath=$signaturePath" `
    "-p:PublisherCertificatePath=$certificatePath" `
    -o $setupPublish
if ($LASTEXITCODE -ne 0) { throw 'Installer publish failed.' }
$setupExecutable = Join-Path $setupPublish 'NEC-Open-World-Setup.exe'
$setupSignature = Set-AuthenticodeSignature -LiteralPath $setupExecutable -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer $TimestampServer
if (-not $setupSignature.SignerCertificate -or $setupSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'The setup executable was not signed by the release certificate.'
}
Copy-Item -LiteralPath $setupExecutable -Destination (Join-Path $resolvedOutput 'NEC-Open-World-Setup.exe') -Force
$publishedSetup = Join-Path $resolvedOutput 'NEC-Open-World-Setup.exe'

function Format-ReleaseByteSize([long]$Bytes) {
    if ($Bytes -ge 1GB) { return '{0:0.00} GiB' -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return '{0:0.0} MiB' -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return '{0:0.0} KiB' -f ($Bytes / 1KB) }
    return "$Bytes bytes"
}

$releaseManifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$additionalDownloadBytes = [long](($releaseManifest.assets | Measure-Object -Property downloadBytes -Sum).Sum)
$setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $publishedSetup).Hash.ToLowerInvariant()
$releaseBody = @(
    "# Northeast Corridor Open World $Version",
    '',
    '## Download',
    '',
    "Download exactly one file: [NEC-Open-World-Setup.exe]($($ReleaseAssetBaseUrl.TrimEnd('/'))/NEC-Open-World-Setup.exe) ($(Format-ReleaseByteSize (Get-Item -LiteralPath $publishedSetup).Length)).",
    '',
    'The setup app downloads and verifies the mod, the 34 map-data packages, and the separate tile-server executable. Do not download the data ZIPs individually.',
    '',
    '## Space required',
    '',
    "- Additional setup downloads: $(Format-ReleaseByteSize $additionalDownloadBytes)",
    "- Installed files: $(Format-ReleaseByteSize ([long]$releaseManifest.space.installedBytes))",
    "- Free space required while installing: $(Format-ReleaseByteSize ([long]$releaseManifest.space.requiredFreeBytes))",
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

Write-Host "Created self-signed NEC release $Version"
Write-Host "Certificate thumbprint: $($certificate.Thumbprint)"
Write-Host "Output: $resolvedOutput"
