param(
    [switch]$SkipDownloads,
    [switch]$SkipImageBuild
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$OsmDirectory = Join-Path $ProjectRoot 'raw-data\osm'
$Image = 'kc-two-tile-depot:ef4ab40'

New-Item -ItemType Directory -Force -Path $OsmDirectory | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'artifacts\depot') | Out-Null

$Sources = @(
    @{ Name = 'kansas-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/kansas-latest.osm.pbf' },
    @{ Name = 'missouri-latest.osm.pbf'; Url = 'https://download.geofabrik.de/north-america/us/missouri-latest.osm.pbf' }
)

if (-not $SkipDownloads) {
    foreach ($Source in $Sources) {
        $Destination = Join-Path $OsmDirectory $Source.Name
        Write-Host "Downloading $($Source.Name) (resumes partial downloads)..."
        & curl.exe --fail --location --retry 3 --continue-at - --output $Destination $Source.Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($Source.Url)" }
    }
}

if (-not $SkipImageBuild) {
    Write-Host "Building the pinned Depot toolchain image..."
    & docker build --tag $Image --file (Join-Path $PSScriptRoot 'Dockerfile') $PSScriptRoot
    if ($LASTEXITCODE -ne 0) { throw 'Depot Docker image build failed.' }
}

Write-Host 'Generating the corridor-wide KCOW map archive and runtime assets...'
& docker run --rm --memory 24g --cpus 8 `
    --volume "${ProjectRoot}:/work" `
    --volume 'kc-two-tile-planetiler-data:/planetiler-data' `
    $Image python /work/depot/generate_kcow.py
if ($LASTEXITCODE -ne 0) { throw 'Depot map generation failed.' }

$Archive = Join-Path $ProjectRoot 'artifacts\depot\KCOW\KCOW.pmtiles'
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "Missing output archive: $Archive" }
Write-Host "Generated $Archive"
