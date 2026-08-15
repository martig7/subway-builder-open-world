param(
    [switch]$ForceWorldBasemap
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tilesRoot = Join-Path $prototypeRoot 'generated\pilot\tiles'
$basemapRoot = Join-Path $prototypeRoot 'generated\pilot\basemap'
$buildRoot = Join-Path $prototypeRoot 'generated\pilot\unified-build'
$rawBasemapRoot = Join-Path $prototypeRoot 'raw-data\basemap'
$worldMbtiles = Join-Path $basemapRoot 'world-z0-z9.mbtiles'
$worldPmtiles = Join-Path $basemapRoot 'world-z0-z9.pmtiles'
$image = 'kc-two-tile-depot:ef4ab40'
$naturalEarthAssets = @(
    [pscustomobject]@{ Name = 'ne_10m_land.geojson'; Sha256 = '1AC90796408BC6AD6911D69448485D3C4DBF2190370080368A09976E1C9F7416' },
    [pscustomobject]@{ Name = 'ne_10m_lakes.geojson'; Sha256 = '2D036F53DEDEC578001C5C30C2959EE7D4EEBC1306900FA4367C49929EC8F2D9' },
    [pscustomobject]@{ Name = 'ne_10m_admin_0_boundary_lines_land.geojson'; Sha256 = '74D9C16229C095FDE65943A9919E337682F044BCEBCCB120764F38EDF3B70F4A' }
)
$tileIds = @(
    'NY_CP00_RP00',
    'NY_CP00_RP01',
    'NY_CP01_RP00',
    'NY_CM01_RP01',
    'NY_CM01_RP02',
    'NY_CM01_RP03',
    'NY_CP00_RP02'
)

function Invoke-DepotTool([string[]]$Arguments) {
    & docker run --rm --volume "${prototypeRoot}:/work" $image @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Depot tool failed: $($Arguments -join ' ')" }
}

function ContainerPath([string]$HostPath) {
    $relative = [System.IO.Path]::GetRelativePath($prototypeRoot, $HostPath).Replace('\', '/')
    return "/work/$relative"
}

foreach ($directory in @($rawBasemapRoot, $basemapRoot, $buildRoot)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

foreach ($asset in $naturalEarthAssets) {
    $assetPath = Join-Path $rawBasemapRoot $asset.Name
    $assetUrl = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/$($asset.Name)"
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
        Write-Host "Downloading pinned Natural Earth asset $($asset.Name)..."
        & curl.exe --fail --location --retry 3 --output $assetPath $assetUrl
        if ($LASTEXITCODE -ne 0) { throw "Could not download $assetUrl" }
    }
    $actualHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash
    if ($actualHash -ne $asset.Sha256) {
        throw "Natural Earth checksum mismatch for $($asset.Name): expected $($asset.Sha256), got $actualHash"
    }
}

if ($ForceWorldBasemap -or -not (Test-Path -LiteralPath $worldPmtiles -PathType Leaf)) {
    foreach ($path in @($worldMbtiles, $worldPmtiles)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
    Write-Host 'Building the shared z0-z9 world land, lakes, and boundary tiles...'
    Invoke-DepotTool @(
        'tippecanoe', '--force',
        "--output=$(ContainerPath $worldMbtiles)",
        '--minimum-zoom=0', '--maximum-zoom=9',
        '--no-feature-limit', '--no-tile-size-limit',
        '-L', "world_land:$(ContainerPath (Join-Path $rawBasemapRoot 'ne_10m_land.geojson'))",
        '-L', "water:$(ContainerPath (Join-Path $rawBasemapRoot 'ne_10m_lakes.geojson'))",
        '-L', "world_boundaries:$(ContainerPath (Join-Path $rawBasemapRoot 'ne_10m_admin_0_boundary_lines_land.geojson'))"
    )
    Invoke-DepotTool @(
        'pmtiles', 'convert', '--force',
        (ContainerPath $worldMbtiles), (ContainerPath $worldPmtiles)
    )
}
Invoke-DepotTool @('pmtiles', 'verify', (ContainerPath $worldPmtiles))

$results = @()
foreach ($tileId in $tileIds) {
    $tileDirectory = Join-Path $tilesRoot $tileId
    $archive = Join-Path $tileDirectory 'tiles.pmtiles'
    $cityOnly = Join-Path $tileDirectory 'tiles.city-only.pmtiles'
    $highZoom = Join-Path $buildRoot "$tileId-high.pmtiles"
    $candidate = Join-Path $buildRoot "$tileId.pmtiles"
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Missing archive: $archive" }
    if (-not (Test-Path -LiteralPath $cityOnly -PathType Leaf)) {
        Copy-Item -LiteralPath $archive -Destination $cityOnly
    }
    foreach ($path in @($highZoom, $candidate)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }

    Write-Host "Merging world z0-z9 with $tileId z10-z15..."
    Invoke-DepotTool @(
        'pmtiles', 'extract', '--minzoom=10', '--maxzoom=15',
        (ContainerPath $cityOnly), (ContainerPath $highZoom)
    )
    # The first input owns JSON metadata and the archive center. Keeping the
    # city archive first retains the native vector-layer catalog and city view;
    # the PMTiles header still expands to the union's global bounds and z0-z15.
    Invoke-DepotTool @(
        'pmtiles', 'merge',
        (ContainerPath $highZoom), (ContainerPath $worldPmtiles), (ContainerPath $candidate)
    )
    Invoke-DepotTool @('pmtiles', 'verify', (ContainerPath $candidate))

    $show = & docker run --rm --volume "${prototypeRoot}:/work" $image pmtiles show (ContainerPath $candidate)
    if ($LASTEXITCODE -ne 0 -or ($show -join "`n") -notmatch 'min zoom: 0' -or ($show -join "`n") -notmatch 'max zoom: 15') {
        throw "$tileId candidate does not advertise z0-z15"
    }
    $remoteBytes = & docker run --rm --volume "${prototypeRoot}:/work" $image sh -lc "pmtiles tile '$(ContainerPath $candidate)' 2 2 2 | wc -c"
    if ($LASTEXITCODE -ne 0 -or [int64]$remoteBytes -le 0) {
        throw "$tileId candidate has no world tile at z2/2/2"
    }
    $midZoomBytes = & docker run --rm --volume "${prototypeRoot}:/work" $image sh -lc "pmtiles tile '$(ContainerPath $candidate)' 8 128 128 | wc -c"
    if ($LASTEXITCODE -ne 0 -or [int64]$midZoomBytes -le 0) {
        throw "$tileId candidate has no detailed world tile at z8/128/128"
    }

    Move-Item -LiteralPath $candidate -Destination $archive -Force
    Remove-Item -LiteralPath $highZoom -Force
    $results += [pscustomobject]@{
        Tile = $tileId
        WorldProbeBytes = [int64]$remoteBytes
        MidZoomProbeBytes = [int64]$midZoomBytes
        CityOnlyMiB = [math]::Round((Get-Item -LiteralPath $cityOnly).Length / 1MB, 1)
        UnifiedMiB = [math]::Round((Get-Item -LiteralPath $archive).Length / 1MB, 1)
    }
}

$results | Format-Table -AutoSize
Write-Host 'Unified z0-z9 world / z10-z15 city PMTiles archives are ready. Original city-only archives are retained as tiles.city-only.pmtiles.'
