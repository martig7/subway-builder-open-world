param(
    [Parameter(Mandatory = $true)]
    [string]$Root
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $Root 'inputs\run_japan_map_queue.ps1'
$logs = Join-Path $Root 'logs'
$stdout = Join-Path $logs 'queue.stdout.log'
$stderr = Join-Path $logs 'queue.stderr.log'
$status = Join-Path $logs 'queue.status.json'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$PID | Set-Content -LiteralPath (Join-Path $logs 'queue.pid') -Encoding ascii

function Write-QueueStatus([string]$state, [int]$exitCode) {
    [ordered]@{
        schemaVersion = 1
        state = $state
        exitCode = $exitCode
        processId = $PID
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8
}

Write-QueueStatus -state 'running' -exitCode 0
try {
    & $runner -Root $Root *>&1 | Tee-Object -FilePath $stdout -Append
    if ($LASTEXITCODE -ne 0) { throw "Japan map queue exited with code $LASTEXITCODE" }
    Write-QueueStatus -state 'complete' -exitCode 0
} catch {
    $_ | Out-String | Add-Content -LiteralPath $stderr -Encoding utf8
    Write-QueueStatus -state 'failed' -exitCode 1
    exit 1
}
