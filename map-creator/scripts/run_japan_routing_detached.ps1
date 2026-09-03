param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot
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
    & python -m open_world_map_creator.routing `
        --catalog (Join-Path $Root 'tile-views.json') `
        --maps-dir $MapsRoot `
        --demand-dir (Join-Path $Root 'demand') `
        --report-namespace japan-national `
        --consumer-manifest-id local.japan-open-world `
        --progress-jsonl (Join-Path $logs 'routing-progress.jsonl') *>&1 |
        Tee-Object -FilePath $stdout -Append
    if ($LASTEXITCODE -ne 0) { throw "Japan routing exited with code $LASTEXITCODE" }
    Write-RoutingStatus -state 'complete' -exitCode 0
} catch {
    $_ | Out-String | Add-Content -LiteralPath $stderr -Encoding utf8
    Write-RoutingStatus -state 'failed' -exitCode 1
    exit 1
}
