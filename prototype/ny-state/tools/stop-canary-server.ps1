param([int]$Port = 8798)

$ErrorActionPreference = 'Stop'
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:APPDATA) { $env:APPDATA } else { $env:TEMP }
$pidPath = Join-Path $stateRoot "metro-maker4\ny-state-six-tile-pmtiles\server-$Port.pid"
if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Host "New York PMTiles server is not running on port $Port."
    exit 0
}
$serverPid = 0
if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$serverPid)) {
    try { Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue } catch {}
}
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
Write-Host "New York PMTiles server stopped on port $Port."
