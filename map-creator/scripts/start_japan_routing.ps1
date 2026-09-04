param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot,
    [string]$DemandRoot,
    [string]$Invalidation
)

$runner = Join-Path $Root 'run_japan_routing_detached.ps1'
$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $runner,
    '-Root', $Root,
    '-MapsRoot', $MapsRoot
)
if ($DemandRoot) { $arguments += @('-DemandRoot', $DemandRoot) }
if ($Invalidation) { $arguments += @('-Invalidation', $Invalidation) }
$process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -PassThru
Write-Output $process.Id
