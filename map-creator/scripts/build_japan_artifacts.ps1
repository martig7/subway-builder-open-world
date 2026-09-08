param(
    [string[]]$Tile,
    [switch]$SkipDownloads,
    [switch]$SkipMaps,
    [switch]$SkipDemand,
    [switch]$SkipRouting,
    [string]$Image = 'kc-two-tile-depot:ef4ab40'
)

$ErrorActionPreference = 'Stop'
$mapCreatorRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $mapCreatorRoot
$worldRoot = Join-Path $repositoryRoot 'worlds\japan'
$prototypeRoot = Join-Path $repositoryRoot 'prototype\japan'
$generatedRoot = Join-Path $prototypeRoot 'generated'
$dataRoot = Join-Path $mapCreatorRoot 'data'
$osmRoot = Join-Path $dataRoot 'sources\japan-osm'
$mapConfigPath = Join-Path $worldRoot 'map.json'
$catalogPath = Join-Path $worldRoot 'geography\tile-views.json'
$progressRoot = Join-Path $dataRoot 'logs\japan-open-world'
$mapConfig = Get-Content -Raw -LiteralPath $mapConfigPath | ConvertFrom-Json

New-Item -ItemType Directory -Force -Path $osmRoot,$progressRoot | Out-Null
if (-not $SkipDownloads) {
    foreach ($source in $mapConfig.sources.PSObject.Properties.Value) {
        $destination = Join-Path $osmRoot $source.filename
        if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
            Write-Host "[Japan Open World] downloading $($source.filename)"
            & curl.exe --fail --location --retry 3 --continue-at - --output $destination $source.uri
            if ($LASTEXITCODE -ne 0) { throw "Download failed: $($source.uri)" }
        }
    }
}

if (-not $SkipMaps) {
    $dockerArguments = @(
        'run', '--rm', '--memory', '56g', '--cpus', '20',
        '--volume', "${repositoryRoot}:/repo",
        '--volume', 'japan-open-world-planetiler-data:/planetiler-data',
        $Image,
        'python', '/repo/map-creator/src/open_world_map_creator/maps/japan_depot.py',
        '--catalog', '/repo/worlds/japan/geography/tile-views.json',
        '--map-config', '/repo/worlds/japan/map.json',
        '--osm-root', '/repo/map-creator/data/sources/japan-osm',
        '--output-root', '/repo/prototype/japan/generated/maps',
        '--planetiler-root', '/planetiler-data',
        '--progress-jsonl', '/repo/map-creator/data/logs/japan-open-world/map-progress.jsonl'
    )
    foreach ($tileId in $Tile) { $dockerArguments += @('--tile', $tileId) }
    & docker @dockerArguments
    if ($LASTEXITCODE -ne 0) { throw 'Japan map generation failed.' }
}

$env:PYTHONPATH = Join-Path $mapCreatorRoot 'src'
# A label-only stage: never regenerate demand or routing to change presentation.
$labelArgs = @(
    (Join-Path $PSScriptRoot 'publish_japan_labels.py'),
    '--maps-root', (Join-Path $generatedRoot 'maps'),
    '--catalog', $catalogPath,
    '--definition', (Join-Path $worldRoot 'labels.json'),
    '--sources-root', (Join-Path $dataRoot 'sources'),
    '--backup-root', (Join-Path $dataRoot 'backups/japan-labels')
)
foreach ($tileId in $Tile) { $labelArgs += @('--tile', $tileId) }
python @labelArgs
if ($LASTEXITCODE -ne 0) { throw 'Japan label publication failed.' }
if (-not $SkipMaps) {
    # Filter both collision and rendered building data before demand placement.
    # Keep full route/label/water layers, and retain the original map packages.
    $buildingRun = Get-Date -Format 'yyyyMMdd-HHmmss'
    $buildingCatalog = Get-Content -Raw -LiteralPath $catalogPath | ConvertFrom-Json
    $buildingTiles = if ($Tile) { $Tile } else { @($buildingCatalog.tiles.id) }
    foreach ($tileId in $buildingTiles) {
        $package = Join-Path $generatedRoot "maps/tiles/$tileId"
        $buildingTile = @($buildingCatalog.tiles | Where-Object id -EQ $tileId)
        if ($buildingTile.Count -ne 1) { throw "Unknown building package $tileId" }
        $boundaryTileId = "JP_PREF_$($buildingTile[0].prefCode)"
        python -m open_world_map_creator.maps.building_boundary `
            --boundary (Join-Path $dataRoot 'sources/japan/geography/prefectures-full.geojson') `
            --tile $tileId --boundary-tile $boundaryTileId --index (Join-Path $package 'buildings_index.bin.gz') `
            --pmtiles (Join-Path $package 'tiles.pmtiles') `
            --output (Join-Path $generatedRoot "maps/ownership-filtered/$buildingRun/$tileId") `
            --publish-to $package --backup-root (Join-Path $dataRoot "backups/building-ownership/$buildingRun")
        if ($LASTEXITCODE -ne 0) { throw "Building ownership filtering failed for $tileId" }
    }
}
if (-not $SkipDemand) {
    python -m open_world_map_creator.demand.package_japan `
        --output-root (Join-Path $generatedRoot 'demand') `
        --progress-jsonl (Join-Path $progressRoot 'demand-progress.jsonl')
    if ($LASTEXITCODE -ne 0) { throw 'Japan demand packaging failed.' }
    python -m open_world_map_creator.demand.verify_japan --demand-root (Join-Path $generatedRoot 'demand')
    if ($LASTEXITCODE -ne 0) { throw 'Japan demand verification failed.' }
}

if (-not $SkipRouting) {
    python -m open_world_map_creator.routing `
        --catalog $catalogPath `
        --maps-dir (Join-Path $generatedRoot 'maps\tiles') `
        --demand-dir (Join-Path $generatedRoot 'demand') `
        --report-namespace japan-national `
        --consumer-manifest-id local.japan-open-world `
        --progress-jsonl (Join-Path $progressRoot 'routing-progress.jsonl')
    if ($LASTEXITCODE -ne 0) { throw 'Japan road enrichment failed.' }
}

Push-Location (Join-Path $prototypeRoot 'mod')
try {
    node scripts/build-mod.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Japan Open World mod build failed.' }
} finally {
    Pop-Location
}
