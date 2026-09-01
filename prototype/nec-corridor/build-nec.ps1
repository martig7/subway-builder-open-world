param(
    [switch]$SkipDownloads,
    [switch]$SkipDemand,
    [switch]$SkipDepot,
    [string[]]$Tile
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$osmDirectory = Join-Path $prototypeRoot 'raw-data\osm'
$nyOsmDirectory = Join-Path $prototypeRoot '..\ny-state\raw-data\osm'
$image = 'kc-two-tile-depot:ef4ab40'
$sources = @(
    @{ Name = 'connecticut-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/connecticut-latest.osm.pbf' },
    @{ Name = 'district-of-columbia-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/district-of-columbia-latest.osm.pbf' },
    @{ Name = 'delaware-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/delaware-latest.osm.pbf' },
    @{ Name = 'massachusetts-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf' },
    @{ Name = 'maryland-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/maryland-latest.osm.pbf' },
    @{ Name = 'maine-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/maine-latest.osm.pbf' },
    @{ Name = 'new-hampshire-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/new-hampshire-latest.osm.pbf' },
    @{ Name = 'new-jersey-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/new-jersey-latest.osm.pbf' },
    @{ Name = 'new-york-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf' },
    @{ Name = 'pennsylvania-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/pennsylvania-latest.osm.pbf' },
    @{ Name = 'rhode-island-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/rhode-island-latest.osm.pbf' },
    @{ Name = 'virginia-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf' },
    @{ Name = 'vermont-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/vermont-latest.osm.pbf' },
    @{ Name = 'west-virginia-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/west-virginia-latest.osm.pbf' }
)

New-Item -ItemType Directory -Force -Path $osmDirectory | Out-Null
if (-not $SkipDownloads) {
    foreach ($source in $sources) {
        $destination = Join-Path $osmDirectory $source.Name
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            $reusable = Join-Path $nyOsmDirectory $source.Name
            if (Test-Path -LiteralPath $reusable -PathType Leaf) {
                Write-Host "Reusing pinned NY OSM extract $($source.Name)..."
                New-Item -ItemType HardLink -Path $destination -Target $reusable | Out-Null
                continue
            }
            Write-Host "Downloading $($source.Name) (resumable)..."
            & curl.exe --fail --location --retry 3 --continue-at - --output $destination $source.Url
            if ($LASTEXITCODE -ne 0) { throw "Download failed: $($source.Url)" }
        }
    }
}

$env:PYTHONPATH = Join-Path $prototypeRoot 'src'
if (-not $SkipDemand) {
    python -m nec_world_builder.cli build-demand
    if ($LASTEXITCODE -ne 0) { throw 'NEC demand build failed.' }
}

if (-not $SkipDepot) {
    if ($Tile) { $env:NEC_DEPOT_TILE_IDS = ($Tile -join ',') }
    & docker run --rm --memory 16g --cpus 8 `
        --volume "${prototypeRoot}:/work" `
        --volume 'kc-two-tile-planetiler-data:/planetiler-data' `
        --env "NEC_DEPOT_TILE_IDS=$($Tile -join ',')" `
        $image python /work/depot/generate_nec.py
    if ($LASTEXITCODE -ne 0) { throw 'NEC Depot build failed.' }
    $basemapArguments = @{}
    if ($Tile) { $basemapArguments.Tile = $Tile }
    & (Join-Path $prototypeRoot 'tools\build-unified-basemaps.ps1') @basemapArguments
    if ($LASTEXITCODE -ne 0) { throw 'Unified NEC low-zoom basemap build failed.' }
}

# This is deliberately a splice after both expensive producers. It reuses the
# completed Depot roads and compact demand cohorts; it never reruns either.
if (-not $SkipDemand -and -not $SkipDepot -and -not $Tile) {
    python -m nec_world_builder.cli enrich-driving
    if ($LASTEXITCODE -ne 0) { throw 'NEC generated-road driving-time splice failed.' }
}
