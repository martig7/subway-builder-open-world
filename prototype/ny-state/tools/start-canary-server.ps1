param([int]$Port = 8798)

$ErrorActionPreference = 'Stop'
$starter = Join-Path $PSScriptRoot 'start-native-pmtiles-server.ps1'
& $starter -Port $Port
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
