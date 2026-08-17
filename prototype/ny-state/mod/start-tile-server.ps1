param([int]$Port = 8798)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tilesRoot = Join-Path $prototypeRoot 'generated\pilot\tiles'
$serverScript = Join-Path $prototypeRoot 'tools\native-pmtiles-server.ps1'
$expectedServerVersion = 'native-pmtiles-directory-v2'
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { $env:TEMP }
$pidPath = Join-Path $stateRoot "metro-maker4\ny-state-six-tile-pmtiles\server-$Port.pid"

function Test-TileServerHealth {
    param([int]$HealthPort)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:${HealthPort}/_health"
        return $response.StatusCode -eq 200 -and
            $response.Headers['X-PMTiles-Server-Version'] -eq $expectedServerVersion
    } catch {
        return $false
    }
}

function Get-NativeTileServerPids {
    $pids = [System.Collections.Generic.List[int]]::new()
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        [int]$recordedPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$recordedPid) -and
            (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue)) {
            [void]$pids.Add($recordedPid)
        }
    }
    try {
        $portText = [string]$Port
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match 'native-pmtiles-server\.ps1' -and
            $_.CommandLine -match "\b$portText\b"
        })) {
            [int]$processId = $process.ProcessId
            if ($processId -ne $PID -and -not $pids.Contains($processId)) { [void]$pids.Add($processId) }
        }
    } catch {}
    return @($pids)
}

function Stop-NativeTileServer {
    foreach ($serverPid in @(Get-NativeTileServerPids)) {
        try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

try {
    if (-not (Test-Path -LiteralPath $tilesRoot -PathType Container)) {
        throw "No generated tile directory found: $tilesRoot"
    }
    if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
        throw "Native PMTiles server script is missing: $serverScript"
    }

    if (Test-TileServerHealth -HealthPort $Port) {
        $existingPids = @(Get-NativeTileServerPids)
        if (-not $existingPids.Count) {
            throw "A native PMTiles server is already running on port $Port, but its process could not be identified safely. Stop it with tools\stop-canary-server.ps1 before retrying."
        }
        Write-Host "Replacing the existing native PMTiles server on port $Port (PID $($existingPids -join ', '))."
        Stop-NativeTileServer
        Start-Sleep -Milliseconds 250
        if (Test-TileServerHealth -HealthPort $Port) {
            throw "The existing tile server on port $Port did not stop."
        }
    }

    Write-Host "Starting the native PMTiles server on port $Port."
    Write-Host "Keep this window open; closing it or pressing Ctrl+C stops the server."

    # Run the listener in this same PowerShell process. A double-clicked
    # PowerShell window therefore remains occupied by the server, and closing
    # that window cannot leave a detached tile-server child behind.
    & $serverScript -Root $tilesRoot -BindHost '127.0.0.1' -Port $Port
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Host "Tile server stopped or failed to start:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    try { [void](Read-Host 'Press Enter to close this PowerShell window') } catch {}
    exit 1
}
