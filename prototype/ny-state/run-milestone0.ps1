param(
    [string]$CacheDir = ""
)

$prototypeRoot = $PSScriptRoot
$env:PYTHONPATH = Join-Path $prototypeRoot "src"
$arguments = @("-m", "ny_world_builder.cli", "milestone0")
if ($CacheDir) {
    $arguments += @("--cache-dir", $CacheDir)
}
python @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

