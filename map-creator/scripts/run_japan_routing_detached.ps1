param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot,
    [string]$DemandRoot,
    [string]$Invalidation,
    [ValidateSet('generated-roads', 'osrm')]
    [string]$RoutingProvider = 'generated-roads',
    [string]$OsrmBaseUrl = 'http://127.0.0.1:5000',
    [string]$OsrmDatasetId,
    [string]$OsrmCache,
    [string]$PassengerFerryCatalog,
    [double]$FerryTransferSeconds = 300,
    [string]$WaterLandGeojson,
    [double]$WaterMaxAccessMetres = 1500,
    [int]$OsrmWorkers = 16,
    [int]$OsrmMaxTableCoordinates = 100,
    [double]$MaxRoutedDirectMetres = 3000000
)

$ErrorActionPreference = 'Stop'
$logs = Join-Path $Root 'logs'
$stdout = Join-Path $logs 'routing.stdout.log'
$stderr = Join-Path $logs 'routing.stderr.log'
$status = Join-Path $logs 'routing.status.json'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$PID | Set-Content -LiteralPath (Join-Path $logs 'routing.pid') -Encoding ascii

function Write-RoutingStatus([string]$state, [int]$exitCode) {
    [ordered]@{
        schemaVersion = 1
        state = $state
        exitCode = $exitCode
        processId = $PID
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8
}

Write-RoutingStatus -state 'running' -exitCode 0
try {
    $env:PYTHONPATH = Join-Path $Root 'src'
    if (-not $DemandRoot) { $DemandRoot = Join-Path $Root 'demand' }
    $routingArguments = @(
        '-m', 'open_world_map_creator.routing',
        '--catalog', (Join-Path $Root 'tile-views.json'),
        '--maps-dir', $MapsRoot,
        '--demand-dir', $DemandRoot,
        '--report-namespace', 'japan-national',
        '--consumer-manifest-id', 'local.japan-open-world',
        '--routing-provider', $RoutingProvider,
        '--progress-jsonl', (Join-Path $logs 'routing-progress.jsonl')
    )
    if ($Invalidation) { $routingArguments += @('--invalidation', $Invalidation) }
    if ($PassengerFerryCatalog) {
        $routingArguments += @('--passenger-ferry-catalog', $PassengerFerryCatalog,
            '--ferry-transfer-seconds', $FerryTransferSeconds)
    }
    if ($WaterLandGeojson) {
        $routingArguments += @('--water-land-geojson', $WaterLandGeojson,
            '--water-max-access-metres', $WaterMaxAccessMetres)
    }
    if ($RoutingProvider -eq 'osrm') {
        if (-not $OsrmDatasetId) { throw 'OsrmDatasetId is required for OSRM routing' }
        if (-not $OsrmCache) { $OsrmCache = Join-Path $Root 'cache\osrm-routes.sqlite3' }
        $routingArguments += @(
            '--osrm-base-url', $OsrmBaseUrl,
            '--osrm-dataset-id', $OsrmDatasetId,
            '--osrm-cache', $OsrmCache,
            '--osrm-workers', $OsrmWorkers,
            '--osrm-max-table-coordinates', $OsrmMaxTableCoordinates,
            '--max-routed-direct-metres', $MaxRoutedDirectMetres
        )
    }
    & python @routingArguments *>&1 |
        Tee-Object -FilePath $stdout -Append
    if ($LASTEXITCODE -ne 0) { throw "Japan routing exited with code $LASTEXITCODE" }
    Write-RoutingStatus -state 'complete' -exitCode 0
} catch {
    $_ | Out-String | Add-Content -LiteralPath $stderr -Encoding utf8
    Write-RoutingStatus -state 'failed' -exitCode 1
    exit 1
}
