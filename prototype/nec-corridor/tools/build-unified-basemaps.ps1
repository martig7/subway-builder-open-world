param(
    [switch]$ForceWorldBasemap,
    [switch]$PlanOnly,
    [string[]]$Tile
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$nyPrototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $prototypeRoot '..\ny-state'))
$catalogPath = Join-Path $prototypeRoot 'generated\catalog\nec-tile-catalog.json'
$tilesRoot = Join-Path $prototypeRoot 'generated\maps\tiles'
$basemapRoot = Join-Path $prototypeRoot 'generated\maps\basemap'
$buildRoot = Join-Path $prototypeRoot 'generated\maps\unified-build'
$rawBasemapRoot = Join-Path $prototypeRoot 'raw-data\basemap'
$worldMbtiles = Join-Path $basemapRoot 'world-z0-z9.mbtiles'
$worldPmtiles = Join-Path $basemapRoot 'world-z0-z9.pmtiles'
$nyWorldPmtiles = Join-Path $nyPrototypeRoot 'generated\pilot\basemap\world-z0-z9.pmtiles'
$image = 'kc-two-tile-depot:ef4ab40'
$naturalEarthAssets = @(
    [pscustomobject]@{ Name = 'ne_10m_land.geojson'; Sha256 = '1AC90796408BC6AD6911D69448485D3C4DBF2190370080368A09976E1C9F7416' },
    [pscustomobject]@{ Name = 'ne_10m_lakes.geojson'; Sha256 = '2D036F53DEDEC578001C5C30C2959EE7D4EEBC1306900FA4367C49929EC8F2D9' },
    [pscustomobject]@{ Name = 'ne_10m_admin_0_boundary_lines_land.geojson'; Sha256 = '74D9C16229C095FDE65943A9919E337682F044BCEBCCB120764F38EDF3B70F4A' }
)
$worldProbes = @(
    [pscustomobject]@{ zoom = 2; x = 2; y = 2 },
    [pscustomobject]@{ zoom = 8; x = 128; y = 128 }
)

if (-not (Test-Path -LiteralPath $catalogPath -PathType Leaf)) {
    throw "Missing NEC tile catalog: $catalogPath"
}
$catalog = Get-Content -LiteralPath $catalogPath -Raw | ConvertFrom-Json
$allTileIds = @($catalog.tiles | ForEach-Object { [string]$_.id })
$tileIds = if ($Tile) { @($Tile) } else { $allTileIds }
$unknownTileIds = @($tileIds | Where-Object { $_ -notin $allTileIds })
if ($unknownTileIds.Count -gt 0) {
    throw "Unknown NEC tile IDs: $($unknownTileIds -join ', ')"
}

function ContainerPath([string]$HostPath) {
    $resolvedRoot = [System.IO.Path]::GetFullPath($prototypeRoot).TrimEnd('\')
    $resolvedHostPath = [System.IO.Path]::GetFullPath($HostPath)
    $rootPrefix = $resolvedRoot + '\'
    if (-not $resolvedHostPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the NEC prototype root: $resolvedHostPath"
    }
    $relative = $resolvedHostPath.Substring($rootPrefix.Length).Replace('\', '/')
    return "/work/$relative"
}

if ($PlanOnly) {
    [ordered]@{
        tileCount = $tileIds.Count
        worldZooms = @(0, 9)
        cityZooms = @(10, 15)
        worldLayers = @('world_land', 'water', 'world_boundaries')
        containerPathProbe = ContainerPath (Join-Path $prototypeRoot 'generated\maps\tiles')
        worldProbes = $worldProbes
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

function Invoke-DepotTool([string[]]$Arguments) {
    & docker run --rm --volume "${prototypeRoot}:/work" $image @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Depot tool failed: $($Arguments -join ' ')" }
}

function Update-MapManifest([string]$TileDirectory, [string]$Archive) {
    $manifestPath = Join-Path $TileDirectory 'map-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $asset = @($manifest.assets | Where-Object { $_.path -eq 'tiles.pmtiles' })
    if ($asset.Count -ne 1) { throw "Expected one tiles.pmtiles asset in $manifestPath" }
    $asset[0].bytes = [int64](Get-Item -LiteralPath $Archive).Length
    $asset[0].sha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $json = $manifest | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($manifestPath, $json + "`n", [System.Text.UTF8Encoding]::new($false))
}

foreach ($directory in @($rawBasemapRoot, $basemapRoot, $buildRoot)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

if (-not $ForceWorldBasemap -and -not (Test-Path -LiteralPath $worldPmtiles -PathType Leaf) -and
    (Test-Path -LiteralPath $nyWorldPmtiles -PathType Leaf)) {
    Write-Host 'Reusing the verified NY z0-z9 Natural Earth basemap...'
    Copy-Item -LiteralPath $nyWorldPmtiles -Destination $worldPmtiles
}

if ($ForceWorldBasemap -or -not (Test-Path -LiteralPath $worldPmtiles -PathType Leaf)) {
    foreach ($asset in $naturalEarthAssets) {
        $assetPath = Join-Path $rawBasemapRoot $asset.Name
        $nyAssetPath = Join-Path $nyPrototypeRoot "raw-data\basemap\$($asset.Name)"
        $assetUrl = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/$($asset.Name)"
        if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
            if (Test-Path -LiteralPath $nyAssetPath -PathType Leaf) {
                Copy-Item -LiteralPath $nyAssetPath -Destination $assetPath
            } else {
                Write-Host "Downloading pinned Natural Earth asset $($asset.Name)..."
                & curl.exe --fail --location --retry 3 --output $assetPath $assetUrl
                if ($LASTEXITCODE -ne 0) { throw "Could not download $assetUrl" }
            }
        }
        $actualHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash
        if ($actualHash -ne $asset.Sha256) {
            throw "Natural Earth checksum mismatch for $($asset.Name): expected $($asset.Sha256), got $actualHash"
        }
    }
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
    Invoke-DepotTool @('pmtiles', 'convert', '--force', (ContainerPath $worldMbtiles), (ContainerPath $worldPmtiles))
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
    Invoke-DepotTool @('pmtiles', 'extract', '--minzoom=10', '--maxzoom=15', (ContainerPath $cityOnly), (ContainerPath $highZoom))
    Invoke-DepotTool @('pmtiles', 'merge', (ContainerPath $highZoom), (ContainerPath $worldPmtiles), (ContainerPath $candidate))
    Invoke-DepotTool @('pmtiles', 'verify', (ContainerPath $candidate))

    $show = & docker run --rm --volume "${prototypeRoot}:/work" $image pmtiles show (ContainerPath $candidate)
    if ($LASTEXITCODE -ne 0 -or ($show -join "`n") -notmatch 'min zoom: 0' -or ($show -join "`n") -notmatch 'max zoom: 15') {
        throw "$tileId candidate does not advertise z0-z15"
    }
    $probeBytes = @()
    foreach ($probe in $worldProbes) {
        $bytes = & docker run --rm --volume "${prototypeRoot}:/work" $image sh -lc "pmtiles tile '$(ContainerPath $candidate)' $($probe.zoom) $($probe.x) $($probe.y) | wc -c"
        if ($LASTEXITCODE -ne 0 -or [int64]$bytes -le 0) {
            throw "$tileId candidate has no world geography at z$($probe.zoom)/$($probe.x)/$($probe.y)"
        }
        $probeBytes += [int64]$bytes
    }

    Move-Item -LiteralPath $candidate -Destination $archive -Force
    Remove-Item -LiteralPath $highZoom -Force
    Update-MapManifest -TileDirectory $tileDirectory -Archive $archive
    $results += [pscustomobject]@{
        Tile = $tileId
        WorldProbeZ2Bytes = $probeBytes[0]
        WorldProbeZ8Bytes = $probeBytes[1]
        CityOnlyMiB = [math]::Round((Get-Item -LiteralPath $cityOnly).Length / 1MB, 1)
        UnifiedMiB = [math]::Round((Get-Item -LiteralPath $archive).Length / 1MB, 1)
    }
}

$results | Format-Table -AutoSize
Write-Host 'Unified z0-z9 world / z10-z15 NEC PMTiles archives are ready. Original city-only archives are retained as tiles.city-only.pmtiles.'
