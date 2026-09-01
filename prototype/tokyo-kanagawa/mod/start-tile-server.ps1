param(
    [int]$Port = 8800,
    [string]$Root,
    [switch]$Background,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$expectedServerVersion = 'native-pmtiles-directory-v2'
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { $env:TEMP }
$pidPath = Join-Path $stateRoot "metro-maker4\tokyo-kanagawa-pmtiles\server-$Port.pid"

function Test-TileArchiveRoot {
    param([string]$Candidate)
    return $Candidate -and (Test-Path -LiteralPath (Join-Path $Candidate 'JP_TOKYO_MAINLAND\tiles.pmtiles') -PathType Leaf)
}

function Resolve-TileArchiveRoot {
    if ($Root) {
        $explicitRoot = [System.IO.Path]::GetFullPath($Root)
        if (-not (Test-TileArchiveRoot $explicitRoot)) { throw "No Tokyo-Kanagawa PMTiles archives found under $explicitRoot" }
        return $explicitRoot
    }
    $candidates = @(
        (Join-Path $PSScriptRoot 'tiles'),
        (Join-Path $PSScriptRoot '..\generated\mod\tiles'),
        (Join-Path $PSScriptRoot '..\..\generated\mod\tiles')
    )
    if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'metro-maker4\cities\data') }
    foreach ($candidate in $candidates) {
        $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
        if (Test-TileArchiveRoot $resolvedCandidate) { return $resolvedCandidate }
    }
    throw 'No Tokyo-Kanagawa PMTiles archives found in the build, source package, or installed Subway Builder city data.'
}

function Resolve-TileServerScript {
    $candidates = @(
        (Join-Path $PSScriptRoot 'native-pmtiles-server.ps1'),
        (Join-Path $PSScriptRoot '..\tools\native-pmtiles-server.ps1'),
        (Join-Path $PSScriptRoot '..\..\tools\native-pmtiles-server.ps1')
    )
    foreach ($candidate in $candidates) {
        $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
        if (Test-Path -LiteralPath $resolvedCandidate -PathType Leaf) { return $resolvedCandidate }
    }
    throw 'The bundled native PMTiles server script is missing.'
}

$tilesRoot = Resolve-TileArchiveRoot
$serverScript = Resolve-TileServerScript

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

if ($Stop) {
    $existingPids = @(Get-NativeTileServerPids)
    foreach ($serverPid in $existingPids) {
        try { Stop-Process -Id $serverPid -Force -ErrorAction Stop } catch {}
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 40 -and (Test-TileServerHealth -HealthPort $Port); $attempt++) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-TileServerHealth -HealthPort $Port) { throw "The tile server on port $Port did not stop." }
    Write-Host "Tokyo-Kanagawa native PMTiles server stopped."
    return
}

try {
    if (-not (Test-Path -LiteralPath $tilesRoot -PathType Container)) { throw "No generated Tokyo-Kanagawa tile directory found: $tilesRoot" }
    if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw "Native PMTiles server script is missing: $serverScript" }
    if ($Background) {
        if (Test-TileServerHealth -HealthPort $Port) {
            Write-Host "Tokyo-Kanagawa native PMTiles server is already running at http://127.0.0.1:$Port/"
            return
        }
        $stateDirectory = Split-Path -Parent $pidPath
        New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
        $stdoutPath = Join-Path $stateDirectory "server-$Port.stdout.log"
        $stderrPath = Join-Path $stateDirectory "server-$Port.stderr.log"
        $serverArguments = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$serverScript`"",
            '-Root', "`"$tilesRoot`"", '-BindHost', '127.0.0.1', '-Port', [string]$Port
        )
        $server = Start-Process -FilePath 'powershell.exe' -ArgumentList $serverArguments `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        Set-Content -LiteralPath $pidPath -Value $server.Id
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 250
            if (Test-TileServerHealth -HealthPort $Port) {
                Write-Host "Tokyo-Kanagawa native PMTiles server started at http://127.0.0.1:$Port/ (PID $($server.Id))."
                return
            }
            if ($server.HasExited) { throw "Native PMTiles server exited with code $($server.ExitCode). See $stderrPath" }
        }
        throw "Native PMTiles server did not become healthy. See $stderrPath"
    }
    if (Test-TileServerHealth -HealthPort $Port) {
        $existingPids = @(Get-NativeTileServerPids)
        if (-not $existingPids.Count) { throw "A native PMTiles server is already running on port $Port, but its process could not be identified safely." }
        foreach ($serverPid in $existingPids) { try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {} }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 250
        if (Test-TileServerHealth -HealthPort $Port) { throw "The existing tile server on port $Port did not stop." }
    }
    Write-Host "Starting the Tokyo-Kanagawa native PMTiles server at http://127.0.0.1:$Port/"
    & $serverScript -Root $tilesRoot -BindHost '127.0.0.1' -Port $Port
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} catch {
    Write-Host "Tokyo-Kanagawa tile server stopped or failed to start:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $Background) {
        try { [void](Read-Host 'Press Enter to close this PowerShell window') } catch {}
    }
    exit 1
}
