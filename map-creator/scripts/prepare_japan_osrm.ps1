param(
    [Parameter(Mandatory = $true)]
    [string]$OsrmRoot,
    [string]$SourceUrl = 'https://download.geofabrik.de/asia/japan-latest.osm.pbf',
    [string]$Image = 'ghcr.io/project-osrm/osrm-backend:v6.0.0',
    [string]$ContainerName = 'japan-open-world-osrm',
    [int]$Port = 5000,
    [string]$ProgressJsonl
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OsrmRoot | Out-Null
$OsrmRoot = (Resolve-Path -LiteralPath $OsrmRoot).Path
if (-not $ProgressJsonl) { $ProgressJsonl = Join-Path $OsrmRoot 'osrm-preparation-progress.jsonl' }

# Docker Desktop's default config can delegate public-registry access to a
# desktop credential helper that is unavailable in non-interactive runner
# sessions. OSRM's image is public, so use an isolated credential-free config.
$dockerConfig = Join-Path $OsrmRoot 'docker-cli'
New-Item -ItemType Directory -Force -Path $dockerConfig | Out-Null
'{"auths":{}}' | Set-Content -LiteralPath (Join-Path $dockerConfig 'config.json') -Encoding ascii
$env:DOCKER_CONFIG = $dockerConfig

function Write-OsrmProgress([string]$stage, [string]$message, [string]$status = 'running') {
    $event = [ordered]@{
        event = 'osrm-preparation-progress'
        stage = $stage
        status = $status
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        message = $message
    }
    $line = $event | ConvertTo-Json -Compress
    Write-Output $line
    $line | Add-Content -LiteralPath $ProgressJsonl -Encoding utf8
}

function Invoke-Docker([string[]]$Arguments) {
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "docker $($Arguments[0]) exited with code $LASTEXITCODE" }
}

function Test-DockerReady {
    # Windows PowerShell promotes a native program's stderr to an ErrorRecord.
    # Probe with a non-terminating preference so an offline engine can be handled
    # by the Docker Desktop startup path below.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & docker info *> $null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

try {
    if (-not (Test-DockerReady)) {
        $desktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktop)) { throw 'Docker Desktop is not installed' }
        Write-OsrmProgress 'docker' 'starting Docker Desktop'
        Start-Process -FilePath $desktop -WindowStyle Hidden
        $ready = $false
        for ($attempt = 1; $attempt -le 90; $attempt++) {
            Start-Sleep -Seconds 5
            if (Test-DockerReady) { $ready = $true; break }
            if ($attempt % 6 -eq 0) {
                Write-OsrmProgress 'docker' "waiting for Docker Desktop ($attempt/90)"
            }
        }
        if (-not $ready) { throw 'Docker Desktop did not become ready' }
    }
    Write-OsrmProgress 'docker' 'Docker engine ready'

    $pbf = Join-Path $OsrmRoot 'japan-latest.osm.pbf'
    $partial = "$pbf.partial"
    if (-not (Test-Path -LiteralPath $pbf)) {
        Write-OsrmProgress 'download' "downloading $SourceUrl"
        & curl.exe --fail --location --retry 8 --retry-all-errors --continue-at - --output $partial $SourceUrl
        if ($LASTEXITCODE -ne 0) { throw "Japan PBF download exited with code $LASTEXITCODE" }
        Move-Item -Force -LiteralPath $partial -Destination $pbf
    }
    $pbfHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pbf).Hash.ToLowerInvariant()
    $datasetId = "geofabrik-japan-$($pbfHash.Substring(0, 16))-car-v6"
    Write-OsrmProgress 'download' "Japan PBF ready ($datasetId)"

    $volume = "${OsrmRoot}:/data"
    $metrics = Join-Path $OsrmRoot 'japan-latest.osrm.cell_metrics'
    if (-not (Test-Path -LiteralPath $metrics)) {
        Write-OsrmProgress 'extract' 'building OSRM edge-expanded graph'
        Invoke-Docker -Arguments @('run', '--rm', '-t', '-v', $volume, $Image,
            'osrm-extract', '-p', '/opt/car.lua', '/data/japan-latest.osm.pbf')
        Write-OsrmProgress 'partition' 'partitioning OSRM graph for MLD'
        Invoke-Docker -Arguments @('run', '--rm', '-t', '-v', $volume, $Image,
            'osrm-partition', '/data/japan-latest.osrm')
        Write-OsrmProgress 'customize' 'customizing OSRM MLD graph'
        Invoke-Docker -Arguments @('run', '--rm', '-t', '-v', $volume, $Image,
            'osrm-customize', '/data/japan-latest.osrm')
    } else {
        Write-OsrmProgress 'preprocess' 'reusing existing prepared OSRM graph'
    }

    $existing = (& docker ps -a --filter "name=^/${ContainerName}$" --format '{{.Names}}').Trim()
    if ($existing -eq $ContainerName) {
        Write-OsrmProgress 'serve' "replacing existing $ContainerName container"
        Invoke-Docker -Arguments @('rm', '-f', $ContainerName)
    }
    Invoke-Docker -Arguments @(
        'run', '--detach', '--name', $ContainerName, '--restart', 'unless-stopped',
        '--publish', "${Port}:5000", '-v', $volume, $Image,
        'osrm-routed', '--algorithm', 'mld', '--max-table-size', '1000',
        '/data/japan-latest.osrm'
    )
    $healthy = $false
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        try {
            $probe = Invoke-RestMethod -TimeoutSec 5 -Uri "http://127.0.0.1:$Port/route/v1/driving/139.7671,35.6812;139.7006,35.6895?overview=false"
            if ($probe.code -eq 'Ok') { $healthy = $true; break }
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    if (-not $healthy) { throw 'OSRM service did not pass its route probe' }
    [ordered]@{
        schemaVersion = 1
        datasetId = $datasetId
        pbfSha256 = $pbfHash
        image = $Image
        port = $Port
        preparedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OsrmRoot 'dataset.json') -Encoding utf8
    Write-OsrmProgress 'complete' "OSRM service ready ($datasetId)" 'complete'
} catch {
    Write-OsrmProgress 'failed' ($_ | Out-String) 'failed'
    throw
}
