param(
    [int]$Port = 8799,
    [string]$Root,
    [switch]$Background,
    [switch]$Stop,
    [string]$ExpectedInstallRoot
)

$ErrorActionPreference = 'Stop'
$expectedServerVersion = 'native-pmtiles-directory-v2'
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { $env:TEMP }
$pidPath = Join-Path $stateRoot "metro-maker4\nec-corridor-pmtiles\server-$Port.pid"

function Test-TileArchiveRoot {
    param([string]$Candidate)
    return $Candidate -and (Test-Path -LiteralPath (Join-Path $Candidate 'NEC_CP00_RP00\tiles.pmtiles') -PathType Leaf)
}

function Resolve-TileArchiveRoot {
    if ($Root) {
        $explicitRoot = [System.IO.Path]::GetFullPath($Root)
        if (-not (Test-TileArchiveRoot $explicitRoot)) { throw "No NEC PMTiles archives found under $explicitRoot" }
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
    throw 'No NEC PMTiles archives found in the build, source package, or installed Subway Builder city data.'
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

function Test-TileServerHealth {
    param([int]$HealthPort)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:${HealthPort}/_health"
        return $response.StatusCode -eq 200 -and $response.Headers['X-PMTiles-Server-Version'] -eq $expectedServerVersion
    } catch { return $false }
}

function Get-NativeTileServerPids {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    $pids = [System.Collections.Generic.List[int]]::new()
    $resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $scriptPattern = [regex]::Escape($resolvedInstallRoot) + '[\\/](?:start-tile-server|native-pmtiles-server)\.ps1'
    $portPattern = '(?:^|\s)-Port\s+' + [regex]::Escape([string]$Port) + '(?:\s|$)'
    try {
        foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match $scriptPattern -and
            $_.CommandLine -match $portPattern
        })) {
            [int]$processId = $process.ProcessId
            if ($processId -ne $PID -and -not $pids.Contains($processId)) { [void]$pids.Add($processId) }
        }
    } catch {}
    return @($pids)
}

if ($Stop) {
    if (-not $ExpectedInstallRoot) {
        throw 'ExpectedInstallRoot is required when stopping the NEC tile server.'
    }
    $existingPids = @(Get-NativeTileServerPids -InstallRoot $ExpectedInstallRoot)
    foreach ($serverPid in $existingPids) {
        Stop-Process -Id $serverPid -Force -ErrorAction Stop
    }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $remainingPids = @($existingPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if (-not $remainingPids.Count -and -not (Test-TileServerHealth -HealthPort $Port)) { break }
        Start-Sleep -Milliseconds 100
    }
    $remainingPids = @($existingPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remainingPids.Count) {
        throw "Verified NEC tile-server process did not stop: $($remainingPids -join ', ')"
    }
    if (Test-TileServerHealth -HealthPort $Port) {
        throw "A healthy PMTiles server remains on port $Port, but it is not owned by $ExpectedInstallRoot."
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped $($existingPids.Count) verified NEC tile-server process(es) before installation."
    return
}

$tilesRoot = Resolve-TileArchiveRoot
$serverScript = Resolve-TileServerScript

try {
    if (-not (Test-Path -LiteralPath $tilesRoot -PathType Container)) { throw "No generated NEC tile directory found: $tilesRoot" }
    if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw "Native PMTiles server script is missing: $serverScript" }
    if ($Background) {
        if (Test-TileServerHealth -HealthPort $Port) {
            Write-Host "NEC native PMTiles server is already running at http://127.0.0.1:$Port/"
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
                Write-Host "NEC native PMTiles server started at http://127.0.0.1:$Port/ (PID $($server.Id))."
                return
            }
            if ($server.HasExited) { throw "Native PMTiles server exited with code $($server.ExitCode). See $stderrPath" }
        }
        throw "Native PMTiles server did not become healthy. See $stderrPath"
    }
    if (Test-TileServerHealth -HealthPort $Port) {
        $existingPids = @(Get-NativeTileServerPids -InstallRoot $PSScriptRoot)
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
    if (-not $Background) {
        try { [void](Read-Host 'Press Enter to close this PowerShell window') } catch {}
    }
    exit 1
}
