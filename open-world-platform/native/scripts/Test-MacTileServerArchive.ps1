param([Parameter(Mandatory = $true)][string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $prefix = 'Open World Tile Server.app/Contents/'
    foreach ($name in @('MacOS/launcher', 'MacOS/open-world-tile-server', 'Resources/Run Tile Server.command')) {
        $entry = $zip.GetEntry($prefix + $name)
        if (-not $entry) { throw "Missing app executable: $name" }
        if ((($entry.ExternalAttributes -shr 16) -band 511) -ne 493) { throw "Missing 0755 permissions: $name" }
        if ($name -ne 'MacOS/open-world-tile-server') {
            $reader = [System.IO.StreamReader]::new($entry.Open())
            try { $script = $reader.ReadToEnd() } finally { $reader.Dispose() }
            if (-not $script.StartsWith("#!/bin/sh`n") -or $script.Contains("`r")) { throw "Invalid shell encoding: $name" }
        }
    }
    $reader = [System.IO.StreamReader]::new($zip.GetEntry($prefix + 'Info.plist').Open())
    try { [xml]$plist = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($plist.SelectSingleNode('//key[text()="CFBundleExecutable"]/following-sibling::string[1]').InnerText -ne 'launcher') { throw 'Invalid app entry point.' }
} finally { $zip.Dispose() }
$file = [System.IO.File]::OpenRead($Archive)
$reader = [System.IO.BinaryReader]::new($file)
try {
    $file.Position = $file.Length - 22
    if ($reader.ReadUInt32() -ne 0x06054b50) { throw 'Invalid ZIP end record.' }
    $file.Position += 6
    $count = $reader.ReadUInt16()
    $file.Position += 4
    $offset = $reader.ReadUInt32()
    $file.Position = $offset
    for ($i = 0; $i -lt $count; $i++) {
        $start = $file.Position
        if ($reader.ReadUInt32() -ne 0x02014b50) { throw 'Invalid ZIP entry.' }
        $file.Position++
        if ($reader.ReadByte() -ne 3) { throw 'ZIP entry does not preserve Unix permissions.' }
        $file.Position = $start + 28
        $name = $reader.ReadUInt16()
        $extra = $reader.ReadUInt16()
        $comment = $reader.ReadUInt16()
        $file.Position = $start + 46 + $name + $extra + $comment
    }
} finally { $reader.Dispose() }
Write-Host "PASS: Mac app structure, executable modes, Unix ZIP metadata, and shell encoding: $Archive"
