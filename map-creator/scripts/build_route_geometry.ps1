param(
    [Parameter(Mandatory = $true)][string]$DemandRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$DatasetId,
    [string]$OsrmBaseUrl = 'http://127.0.0.1:5000',
    [ValidateRange(1,64)][int]$Workers = 16
)

# Run on the selected build Runner after demand routing and before mod packaging.
$ErrorActionPreference = 'Stop'
$creatorRoot = Split-Path -Parent $PSScriptRoot
python (Join-Path $creatorRoot 'src/open_world_map_creator/routing/route_geometry.py') `
    --demand-root $DemandRoot --output-root $OutputRoot --dataset-id $DatasetId `
    --osrm-base-url $OsrmBaseUrl --workers $Workers
if ($LASTEXITCODE -ne 0) { throw 'Stored driving-route geometry generation failed.' }
