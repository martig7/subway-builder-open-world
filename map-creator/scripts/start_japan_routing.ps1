param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot,
    [string]$DemandRoot,
    [string]$Invalidation
)

$runner = Join-Path $Root 'run_japan_routing_detached.ps1'
$logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
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
    -RedirectStandardOutput (Join-Path $logs 'launcher.stdout.log') `
    -RedirectStandardError (Join-Path $logs 'launcher.stderr.log') `
    -PassThru
Write-Output $process.Id
