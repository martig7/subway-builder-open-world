param([int]$Port = 8799)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tilesRoot = Join-Path $prototypeRoot 'generated\mod\tiles'
$serverScript = Join-Path $prototypeRoot 'tools\native-pmtiles-server.ps1'
$expectedServerVersion = 'native-pmtiles-directory-v2'
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { $env:TEMP }
$pidPath = Join-Path $stateRoot "metro-maker4\nec-corridor-pmtiles\server-$Port.pid"

function Test-TileServerHealth {
    param([int]$HealthPort)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:${HealthPort}/_health"
        return $response.StatusCode -eq 200 -and $response.Headers['X-PMTiles-Server-Version'] -eq $expectedServerVersion
    } catch { return $false }
}

function Get-NativeTileServerPids {
    $pids = [System.Collections.Generic.List[int]]::new()
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        [int]$recordedPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$recordedPid) -and
            (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue)) { [void]$pids.Add($recordedPid) }
    }
    try {
        $portText = [string]$Port
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and $_.CommandLine -match 'native-pmtiles-server\.ps1' -and $_.CommandLine -match "\b$portText\b"
        })) {
            [int]$processId = $process.ProcessId
            if ($processId -ne $PID -and -not $pids.Contains($processId)) { [void]$pids.Add($processId) }
        }
    } catch {}
    return @($pids)
}

try {
    if (-not (Test-Path -LiteralPath $tilesRoot -PathType Container)) { throw "No generated NEC tile directory found: $tilesRoot" }
    if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw "Native PMTiles server script is missing: $serverScript" }
    if (Test-TileServerHealth -HealthPort $Port) {
        $existingPids = @(Get-NativeTileServerPids)
        if (-not $existingPids.Count) { throw "A native PMTiles server is already running on port $Port, but its process could not be identified safely." }
        foreach ($serverPid in $existingPids) { try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {} }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 250
        if (Test-TileServerHealth -HealthPort $Port) { throw "The existing tile server on port $Port did not stop." }
    }
    Write-Host "Starting the NEC native PMTiles server at http://127.0.0.1:$Port/"
    & $serverScript -Root $tilesRoot -BindHost '127.0.0.1' -Port $Port
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Host "NEC tile server stopped or failed to start:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    try { [void](Read-Host 'Press Enter to close this PowerShell window') } catch {}
    exit 1
}
