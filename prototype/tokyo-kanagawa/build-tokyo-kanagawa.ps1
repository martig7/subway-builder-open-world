param(
    [switch]$SkipDownloads,
    [string[]]$Tile
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$osmDirectory = Join-Path $prototypeRoot 'raw-data\osm'
$image = 'kc-two-tile-depot:ef4ab40'
$source = @{
    Name = 'kanto-latest.osm.pbf'
    Url = 'https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf'
}

New-Item -ItemType Directory -Force -Path $osmDirectory | Out-Null
if (-not $SkipDownloads) {
    $destination = Join-Path $osmDirectory $source.Name
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        Write-Host "Downloading the Geofabrik Kanto extract (resumable)..."
        & curl.exe --fail --location --retry 3 --continue-at - --output $destination $source.Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($source.Url)" }
    }
}

if ($Tile) { $env:TOKYO_KANAGAWA_DEPOT_TILE_IDS = ($Tile -join ',') }
& docker run --rm --memory 56g --cpus 20 `
    --volume "${prototypeRoot}:/work" `
    --volume 'tokyo-kanagawa-planetiler-data:/planetiler-data' `
    --env "TOKYO_KANAGAWA_DEPOT_TILE_IDS=$($Tile -join ',')" `
    $image python /work/depot/generate_tokyo_kanagawa.py
if ($LASTEXITCODE -ne 0) { throw 'Tokyo–Kanagawa Depot build failed.' }

$basemapArguments = @{}
if ($Tile) { $basemapArguments.Tile = $Tile }
& (Join-Path $prototypeRoot 'tools\build-unified-basemaps.ps1') @basemapArguments
if ($LASTEXITCODE -ne 0) { throw 'Unified Tokyo–Kanagawa low-zoom basemap build failed.' }
