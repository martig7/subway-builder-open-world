param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [string]$MapsRoot,
    [string]$DemandRoot,
    [string]$Invalidation,
    [ValidateSet('generated-roads', 'osrm')]
    [string]$RoutingProvider = 'generated-roads',
    [string]$OsrmBaseUrl = 'http://127.0.0.1:5000',
    [string]$OsrmDatasetId,
    [string]$OsrmCache,
    [string]$PassengerFerryCatalog,
    [double]$FerryTransferSeconds = 300,
    [int]$OsrmWorkers = 16,
    [int]$OsrmMaxTableCoordinates = 100,
    [double]$MaxRoutedDirectMetres = 3000000
)

$runner = Join-Path $Root 'run_japan_routing_detached.ps1'
$logs = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $runner,
    '-Root', $Root,
    '-MapsRoot', $MapsRoot,
    '-RoutingProvider', $RoutingProvider,
    '-OsrmBaseUrl', $OsrmBaseUrl,
    '-OsrmWorkers', $OsrmWorkers,
    '-OsrmMaxTableCoordinates', $OsrmMaxTableCoordinates,
    '-MaxRoutedDirectMetres', $MaxRoutedDirectMetres
)
if ($DemandRoot) { $arguments += @('-DemandRoot', $DemandRoot) }
if ($Invalidation) { $arguments += @('-Invalidation', $Invalidation) }
if ($OsrmDatasetId) { $arguments += @('-OsrmDatasetId', $OsrmDatasetId) }
if ($OsrmCache) { $arguments += @('-OsrmCache', $OsrmCache) }
if ($PassengerFerryCatalog) {
    $arguments += @('-PassengerFerryCatalog', $PassengerFerryCatalog,
        '-FerryTransferSeconds', $FerryTransferSeconds)
}
$process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'launcher.stdout.log') `
    -RedirectStandardError (Join-Path $logs 'launcher.stderr.log') `
    -PassThru
Write-Output $process.Id
