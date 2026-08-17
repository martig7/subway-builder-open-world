param([int]$Port = 8798)

$ErrorActionPreference = 'Stop'
$expectedServerVersion = 'native-pmtiles-directory-v2'
$prototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tilesRoot = Join-Path $prototypeRoot 'generated\pilot\tiles'
$serverScript = Join-Path $PSScriptRoot 'native-pmtiles-server.ps1'
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { $env:TEMP }
$stateRoot = Join-Path $stateRoot 'metro-maker4\ny-state-six-tile-pmtiles'
$pidPath = Join-Path $stateRoot "server-$Port.pid"
$logPath = Join-Path $stateRoot "server-$Port.log"
$errorLogPath = Join-Path $stateRoot "server-$Port-error.log"

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

function Remove-LegacyDockerContainer {
    # Older builds used this fixed Docker container name. Remove only that
    # known legacy container so an upgrade cannot silently keep using Docker;
    # Docker itself remains optional for the native server.
    $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
    if (-not $docker) { return }
    try {
        $existing = & $docker.Source ps --all --quiet --filter 'name=^/ny-state-six-tile-pmtiles$' 2>$null
        if ($LASTEXITCODE -eq 0 -and $existing) {
            & $docker.Source rm --force ny-state-six-tile-pmtiles 2>$null | Out-Null
        }
    } catch {}
}

Remove-LegacyDockerContainer
$global:LASTEXITCODE = 0
if (Test-TileServerHealth -HealthPort $Port) {
    Write-Host "Native PMTiles server is already running on port $Port."
    exit 0
}

if (-not (Test-Path -LiteralPath $tilesRoot -PathType Container)) {
    throw "No generated tile directory found: $tilesRoot"
}
if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
    throw "Native PMTiles server script is missing: $serverScript"
}

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
$legacyPidPath = Join-Path $stateRoot 'server.pid'
if ($Port -eq 8798 -and (Test-Path -LiteralPath $legacyPidPath)) {
    $legacyPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $legacyPidPath -Raw).Trim(), [ref]$legacyPid)) {
        try { Stop-Process -Id $legacyPid -Force -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item -LiteralPath $legacyPidPath -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $pidPath) {
    $oldPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$oldPid)) {
        try { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
}

$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$quotedServer = '"' + $serverScript + '"'
$quotedRoot = '"' + $tilesRoot + '"'
$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $quotedServer,
    '-Root', $quotedRoot,
    '-BindHost', '127.0.0.1',
    '-Port', "$Port"
)
$process = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath
Set-Content -LiteralPath $pidPath -Value $process.Id -NoNewline

$healthy = $false
foreach ($attempt in 1..40) {
    if ($process.HasExited) { break }
    if (Test-TileServerHealth -HealthPort $Port) { $healthy = $true; break }
    Start-Sleep -Milliseconds 250
}
if (-not $healthy) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $details = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Tail 20 -ErrorAction SilentlyContinue } else { @() }
    throw "Native PMTiles server failed its health check on port $Port. $($details -join ' ')"
}
$global:LASTEXITCODE = 0
Write-Host "Native PMTiles server is running on port $Port (PID $($process.Id))."
Write-Host "http://127.0.0.1:${Port}/NY_CP00_RP00/{z}/{x}/{y}.mvt"
