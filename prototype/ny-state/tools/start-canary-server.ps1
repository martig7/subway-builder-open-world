param([int]$Port = 8798)

$ErrorActionPreference = 'Stop'
$prototypeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tilesRoot = Join-Path $prototypeRoot 'generated\pilot\tiles'
$image = 'kc-two-tile-depot:ef4ab40'
$containerName = 'ny-state-six-tile-pmtiles'
$dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'

function Test-DockerReady {
    $probe = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList @('/d', '/c', 'docker info >nul 2>nul') `
        -PassThru -WindowStyle Hidden
    try {
        if (-not $probe.WaitForExit(2500)) {
            $probe.Kill()
            $probe.WaitForExit()
            return $false
        }
        return $probe.ExitCode -eq 0
    } finally {
        $probe.Dispose()
    }
}

if (-not (Test-DockerReady)) {
    if (-not (Test-Path -LiteralPath $dockerDesktop -PathType Leaf)) {
        throw 'Docker Desktop is not running and could not be found.'
    }
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
    $ready = $false
    foreach ($attempt in 1..30) {
        Start-Sleep -Seconds 2
        if (Test-DockerReady) { $ready = $true; break }
    }
    if (-not $ready) { throw 'Docker Desktop did not become ready within 60 seconds.' }
}

$tileArchives = @(Get-ChildItem -LiteralPath $tilesRoot -Directory | ForEach-Object {
    $archive = Join-Path $_.FullName 'tiles.pmtiles'
    if (Test-Path -LiteralPath $archive -PathType Leaf) {
        [pscustomobject]@{ TileId = $_.Name; Archive = [System.IO.Path]::GetFullPath($archive) }
    }
})
if ($tileArchives.Count -eq 0) { throw "No PMTiles archives found under $tilesRoot" }

$arguments = @(
    'run', '--detach', '--name', $containerName,
    '--restart', 'unless-stopped',
    '--publish', "127.0.0.1:${Port}:8080"
)
foreach ($tile in $tileArchives) {
    $arguments += @('--volume', "$($tile.Archive):/tiles/$($tile.TileId).pmtiles:ro")
}
$arguments += @($image, 'pmtiles', 'serve', '/tiles', '--cors=*')

$existing = & docker ps --all --quiet --filter "name=^/${containerName}$"
if ($LASTEXITCODE -ne 0) { throw 'Could not query Docker. Is Docker Desktop running?' }
if ($existing) {
    & docker rm --force $containerName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not replace Docker container $containerName" }
}
$container = & docker @arguments
if ($LASTEXITCODE -ne 0) { throw 'Could not start the New York PMTiles server.' }
$healthUrl = "http://127.0.0.1:${Port}/NY_CP00_RP00/2/2/2.mvt?v=world-z0-z9-v2"
$healthy = $false
foreach ($attempt in 1..20) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $healthUrl
        if ($response.StatusCode -eq 200 -and $response.RawContentLength -gt 0) { $healthy = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
}
if (-not $healthy) {
    & docker rm --force $containerName | Out-Null
    throw "PMTiles container started but failed its vector-tile health check: $healthUrl"
}
Write-Host "New York PMTiles server is running in $containerName ($container)"
Write-Host "http://127.0.0.1:${Port}/NY_CP00_RP00/{z}/{x}/{y}.mvt"
