$containerName = 'ny-state-six-tile-pmtiles'
$existing = & docker ps --all --quiet --filter "name=^/${containerName}$"
if ($LASTEXITCODE -ne 0) { throw 'Could not query Docker.' }
if ($existing) {
    & docker rm --force $containerName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not stop $containerName" }
    Write-Host 'New York PMTiles server stopped.'
} else {
    Write-Host 'New York PMTiles server is not running.'
}
