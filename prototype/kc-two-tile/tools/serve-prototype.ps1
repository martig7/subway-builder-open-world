param(
    [int]$ArtifactPort = 8787,
    [int]$TilePort = 8788
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Artifacts = Join-Path $ProjectRoot 'artifacts'
$TileDirectory = Join-Path $Artifacts 'depot\KCOW'
$Archive = Join-Path $TileDirectory 'KCOW.pmtiles'
$Image = 'kc-two-tile-depot:ef4ab40'
$ContainerName = "kc-two-tile-pmtiles-$PID"

if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
    throw "Missing $Archive. Run .\depot\build-depot.ps1 first."
}

$Python = (Get-Command python -ErrorAction Stop).Source
$ArtifactServerScript = '"' + (Join-Path $PSScriptRoot 'serve_artifacts.py') + '"'
$QuotedArtifacts = '"' + $Artifacts + '"'
$ArtifactServer = Start-Process -FilePath $Python -WindowStyle Hidden -PassThru -ArgumentList @(
    $ArtifactServerScript,
    '--directory', $QuotedArtifacts,
    '--port', $ArtifactPort
)

try {
    Write-Host "Artifacts: http://127.0.0.1:$ArtifactPort/"
    Write-Host "Map tiles: http://127.0.0.1:$TilePort/KCOW/{z}/{x}/{y}.mvt"
    Write-Host 'Keep this window open while Subway Builder is running. Press Ctrl+C to stop.'
    & docker run --rm --name $ContainerName --publish "127.0.0.1:${TilePort}:8080" --volume "${TileDirectory}:/tiles:ro" $Image pmtiles serve /tiles '--cors=*'
}
finally {
    if (-not $ArtifactServer.HasExited) { Stop-Process -Id $ArtifactServer.Id }
    & docker rm --force $ContainerName 2>$null | Out-Null
}
