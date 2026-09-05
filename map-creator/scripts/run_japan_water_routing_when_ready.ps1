param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$MapsRoot,
    [Parameter(Mandatory = $true)][string]$OriginalDemand,
    [Parameter(Mandatory = $true)][string]$OsrmRoot,
    [Parameter(Mandatory = $true)][string]$FerryCatalog,
    [Parameter(Mandatory = $true)][string]$Cache,
    [Parameter(Mandatory = $true)][string]$LandMask,
    [int]$MaximumWaitMinutes = 120
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$maskReport = [IO.Path]::ChangeExtension($LandMask, '.report.json')
$output = Join-Path $Root 'demand-water'
$env:PYTHONPATH = Join-Path $Root 'src'
$deadline = (Get-Date).AddMinutes($MaximumWaitMinutes)
Write-Output '[water-handoff] waiting for validated physical land mask'
while (-not (Test-Path -LiteralPath $maskReport)) {
    if ((Get-Date) -ge $deadline) { throw 'Physical land mask did not finish before the deadline' }
    Start-Sleep -Seconds 10
}
$mask = Get-Content -LiteralPath $maskReport -Raw | ConvertFrom-Json
if ($mask.status -ne 'complete' -or $mask.unusableAreaIds.Count -gt 0) {
    throw 'Physical land mask requires review before routing (incomplete or unusable water areas)'
}
$actualHash = (Get-FileHash -LiteralPath $LandMask -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $mask.sha256.output) { throw 'Physical land mask hash does not match its report' }
if (-not (Test-Path -LiteralPath $output)) {
    Copy-Item -LiteralPath $OriginalDemand -Destination $output -Recurse
}
$dataset = Get-Content -LiteralPath (Join-Path $OsrmRoot 'dataset.json') -Raw | ConvertFrom-Json
Write-Output '[water-handoff] starting cached road/ferry/water routing'
& (Join-Path $Root 'run_japan_routing_detached.ps1') -Root $Root -MapsRoot $MapsRoot `
    -DemandRoot $output -RoutingProvider osrm -OsrmBaseUrl "http://127.0.0.1:$($dataset.port)" `
    -OsrmDatasetId $dataset.datasetId -OsrmCache $Cache -PassengerFerryCatalog $FerryCatalog `
    -WaterLandGeojson $LandMask -MaxRoutedDirectMetres 3000000
if ($LASTEXITCODE -ne 0) { throw 'Water routing failed; output is not approved for publication' }
Write-Output '[water-handoff] auditing demand conservation and successful-road preservation'
& python -m open_world_map_creator.routing.ferry_audit --before $OriginalDemand --after $output --cache $Cache
if ($LASTEXITCODE -ne 0) { throw 'Routing audit failed; do not publish this output' }
Write-Output '[water-handoff] complete; audited output is ready for build/publication'
