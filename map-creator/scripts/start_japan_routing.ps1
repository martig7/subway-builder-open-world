param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot
)

$runner = Join-Path $Root 'run_japan_routing_detached.ps1'
$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $runner,
    '-Root', $Root,
    '-MapsRoot', $MapsRoot
)
$process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -PassThru
Write-Output $process.Id
