[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ReleaseAssetBaseUrl,
    [Parameter(Mandatory = $true)][string]$NecModRoot,
    [Parameter(Mandatory = $true)][string]$NecTileRoot,
    [string]$TokyoModRoot,
    [string]$TokyoTileRoot,
    [Parameter(Mandatory = $true)][string]$Output,
    [ValidatePattern('^https?://')][string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Publish-NecWindowsRelease.ps1') @PSBoundParameters
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
