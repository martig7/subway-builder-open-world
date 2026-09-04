param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot,
    [Parameter(Mandatory = $true)]
    [string]$DemandRoot,
    [Parameter(Mandatory = $true)]
    [string]$OsrmRoot,
    [string]$Invalidation,
    [int]$WaitSeconds = 30,
    [int]$MaximumWaitHours = 24,
    [int]$OsrmWorkers = 16,
    [int]$OsrmMaxTableCoordinates = 100,
    [double]$MaxRoutedDirectMetres = 3000000
)

$ErrorActionPreference = 'Stop'
$logs = Join-Path $Root 'logs'
$progress = Join-Path $logs 'osrm-routing-handoff.jsonl'
$datasetPath = Join-Path $OsrmRoot 'dataset.json'
$cache = Join-Path $Root 'cache\osrm-routes.sqlite3'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Write-HandoffProgress([string]$stage, [string]$message, [string]$status = 'running') {
    $line = [ordered]@{
        event = 'osrm-routing-handoff'
        stage = $stage
        status = $status
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        message = $message
    } | ConvertTo-Json -Compress
    Write-Output $line
    $line | Add-Content -LiteralPath $progress -Encoding utf8
}

$deadline = (Get-Date).AddHours($MaximumWaitHours)
Write-HandoffProgress 'wait' "waiting for $datasetPath"
while (-not (Test-Path -LiteralPath $datasetPath)) {
    if ((Get-Date) -ge $deadline) { throw "OSRM preparation did not finish within $MaximumWaitHours hours" }
    Start-Sleep -Seconds $WaitSeconds
}

$dataset = Get-Content -Raw -LiteralPath $datasetPath | ConvertFrom-Json
$port = [int]$dataset.port
$baseUrl = "http://127.0.0.1:$port"
$ready = $false
for ($attempt = 1; $attempt -le 120; $attempt++) {
    try {
        $probe = Invoke-RestMethod -TimeoutSec 5 -Uri "$baseUrl/route/v1/driving/139.7671,35.6812;139.7006,35.6895?overview=false"
        if ($probe.code -eq 'Ok') { $ready = $true; break }
    } catch {
        Start-Sleep -Seconds 5
    }
}
if (-not $ready) { throw 'Prepared OSRM service did not pass its route probe' }

Write-HandoffProgress 'route' "starting OSRM routing ($($dataset.datasetId))"
$runner = Join-Path $Root 'run_japan_routing_detached.ps1'
$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $runner,
    '-Root', $Root,
    '-MapsRoot', $MapsRoot,
    '-DemandRoot', $DemandRoot,
    '-RoutingProvider', 'osrm',
    '-OsrmBaseUrl', $baseUrl,
    '-OsrmDatasetId', $dataset.datasetId,
    '-OsrmCache', $cache,
    '-OsrmWorkers', $OsrmWorkers,
    '-OsrmMaxTableCoordinates', $OsrmMaxTableCoordinates,
    '-MaxRoutedDirectMetres', $MaxRoutedDirectMetres
)
if ($Invalidation) { $arguments += @('-Invalidation', $Invalidation) }
& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) { throw "OSRM routing runner exited with code $LASTEXITCODE" }
Write-HandoffProgress 'complete' 'OSRM routing completed' 'complete'
