param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [string[]]$Tile,
    [string]$Image = 'kc-two-tile-depot:ef4ab40'
)

$ErrorActionPreference = 'Stop'
$inputs = Join-Path $Root 'inputs'
$osmRoot = Join-Path $Root 'raw-data\osm'
$mapsRoot = Join-Path $Root 'generated\maps'
$logsRoot = Join-Path $Root 'logs'
$mapConfig = Get-Content -Raw -LiteralPath (Join-Path $inputs 'map.json') | ConvertFrom-Json
$catalog = Get-Content -Raw -LiteralPath (Join-Path $inputs 'tile-views.json') | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $osmRoot,$mapsRoot,$logsRoot | Out-Null

foreach ($source in $mapConfig.sources.PSObject.Properties.Value) {
    $destination = Join-Path $osmRoot $source.filename
    $partial = "$destination.partial"
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
        Write-Output "[Japan Open World] download started $($source.filename)"
        & curl.exe `
            --fail `
            --location `
            --retry 12 `
            --retry-all-errors `
            --retry-delay 5 `
            --continue-at - `
            --output $partial `
            $source.uri
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($source.uri)" }
        Move-Item -Force -LiteralPath $partial -Destination $destination
        Write-Output "[Japan Open World] download complete $($source.filename)"
    } else {
        Write-Output "[Japan Open World] download already complete $($source.filename)"
    }
}

$inventory = foreach ($source in $mapConfig.sources.PSObject.Properties.Value) {
    $path = Join-Path $osmRoot $source.filename
    $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $path
    [ordered]@{ filename = $source.filename; uri = $source.uri; bytes = (Get-Item -LiteralPath $path).Length; sha256 = $hash.Hash.ToLowerInvariant() }
}
$inventory | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logsRoot 'osm-source-inventory.json') -Encoding utf8

$requested = if ($Tile) {
    $Tile
} else {
    @($catalog.tiles | Where-Object { $_.prefCode -notin @('13', '14') } | ForEach-Object { $_.id })
}
$dockerArguments = @(
    'run', '--rm', '--memory', '56g', '--cpus', '20',
    '--volume', "${Root}:/work",
    '--volume', 'japan-open-world-planetiler-data:/planetiler-data',
    $Image,
    'python', '/work/inputs/japan_depot.py',
    '--catalog', '/work/inputs/tile-views.json',
    '--map-config', '/work/inputs/map.json',
    '--osm-root', '/work/raw-data/osm',
    '--output-root', '/work/generated/maps',
    '--planetiler-root', '/planetiler-data',
    '--progress-jsonl', '/work/logs/map-progress.jsonl'
)
foreach ($tileId in $requested) { $dockerArguments += @('--tile', $tileId) }
Write-Output "[Japan Open World] map queue started tiles=$($requested.Count)"
& docker @dockerArguments
if ($LASTEXITCODE -ne 0) { throw 'Japan map queue failed.' }
Write-Output "[Japan Open World] map queue complete tiles=$($requested.Count)"
