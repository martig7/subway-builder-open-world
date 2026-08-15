param(
    [switch]$SkipDownloads,
    [switch]$SkipDepot,
    [switch]$SkipDemand,
    [switch]$SkipBenchmarks
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$osmDirectory = Join-Path $prototypeRoot 'raw-data\osm'
$image = 'kc-two-tile-depot:ef4ab40'
$sources = @(
    @{ Name = 'new-york-260810.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/new-york-260810.osm.pbf' },
    @{ Name = 'new-jersey-260810.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/new-jersey-260810.osm.pbf' },
    @{ Name = 'pennsylvania-260810.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/pennsylvania-260810.osm.pbf' },
    @{ Name = 'connecticut-260810.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/connecticut-260810.osm.pbf' },
    @{ Name = 'massachusetts-260810.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/massachusetts-260810.osm.pbf' },
    @{ Name = 'vermont-260810.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/vermont-260810.osm.pbf' }
)

New-Item -ItemType Directory -Force -Path $osmDirectory | Out-Null
if (-not $SkipDownloads) {
    foreach ($source in $sources) {
        $destination = Join-Path $osmDirectory $source.Name
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            Write-Host "Downloading $($source.Name) (resumable)..."
            & curl.exe --fail --location --retry 3 --continue-at - --output $destination $source.Url
            if ($LASTEXITCODE -ne 0) { throw "Download failed: $($source.Url)" }
        }
    }
}

if (-not $SkipDemand) {
    $env:PYTHONPATH = Join-Path $prototypeRoot 'src'
    python -m ny_world_builder.cli build-pilot-demand
    if ($LASTEXITCODE -ne 0) { throw 'Pilot demand build failed.' }
}

if (-not $SkipDepot) {
    & docker run --rm --memory 16g --cpus 8 `
        --volume "${prototypeRoot}:/work" `
        --volume 'kc-two-tile-planetiler-data:/planetiler-data' `
        $image python /work/depot/generate_ny_pilot.py
    if ($LASTEXITCODE -ne 0) { throw 'Pilot Depot build failed.' }
    & (Join-Path $prototypeRoot 'tools\build-unified-basemaps.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Unified low-zoom basemap build failed.' }
}

if (-not $SkipBenchmarks) {
    npm --prefix $prototypeRoot run pilot:routing
    if ($LASTEXITCODE -ne 0) { throw 'Pilot routing benchmark failed.' }
    npm --prefix $prototypeRoot run pilot:benchmark
    if ($LASTEXITCODE -ne 0) { throw 'Pilot feasibility benchmark failed.' }
}
