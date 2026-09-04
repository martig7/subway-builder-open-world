[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Manual,
    [Parameter(Mandatory = $true)][string]$Readme,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$prefix = 'Open World Tile Server.app/Contents/'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$launcher = @'
#!/bin/sh
contents=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
exec /usr/bin/open -a Terminal "$contents/Resources/Run Tile Server.command"
'@
$runner = @'
#!/bin/sh
contents=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
printf '\033]0;Open World Tile Server\007'
printf 'Open World Tile Server\nKeep this window open while playing.\n\n'
"$contents/MacOS/open-world-tile-server" serve --root "$HOME/Library/Application Support/metro-maker4/cities/data"
result=$?
if [ "$result" -ne 0 ]; then
    printf '\nTile server stopped with error %s. Press Enter to close.\n' "$result"
    read -r answer
fi
exit "$result"
'@
$escapedVersion = [System.Security.SecurityElement]::Escape($Version)
$plist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Open World Tile Server</string>
<key>CFBundleDisplayName</key><string>Open World Tile Server</string>
<key>CFBundleIdentifier</key><string>com.gcm.open-world.tile-server</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundleShortVersionString</key><string>$escapedVersion</string>
<key>CFBundleVersion</key><string>$escapedVersion</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
"@

# CreateNew prevents accidental replacement of an unrelated archive.
$file = [System.IO.File]::Open($Output, 'CreateNew', 'ReadWrite', 'None')
try {
    $zip = [System.IO.Compression.ZipArchive]::new($file, 'Create', $true)
    try {
        $items = @(
            @{ Name = $prefix + 'Info.plist'; Text = $plist; Mode = 33188 },
            @{ Name = $prefix + 'MacOS/launcher'; Text = $launcher; Mode = 33261 },
            @{ Name = $prefix + 'Resources/Run Tile Server.command'; Text = $runner; Mode = 33261 },
            @{ Name = $prefix + 'MacOS/open-world-tile-server'; Path = $Executable; Mode = 33261 },
            @{ Name = 'MANUAL-INSTALLATION.md'; Path = $Manual; Mode = 33188 },
            @{ Name = 'README.txt'; Path = $Readme; Mode = 33188 }
        )
        foreach ($item in $items) {
            $entry = $zip.CreateEntry($item.Name, 'Optimal')
            $entry.ExternalAttributes = $item.Mode -shl 16
            $destination = $entry.Open()
            try {
                if ($item.ContainsKey('Path')) {
                    $source = [System.IO.File]::OpenRead($item.Path)
                    try { $source.CopyTo($destination) } finally { $source.Dispose() }
                } else {
                    $bytes = $utf8.GetBytes($item.Text.Replace("`r`n", "`n") + "`n")
                    $destination.Write($bytes, 0, $bytes.Length)
                }
            } finally { $destination.Dispose() }
        }
    } finally { $zip.Dispose() }

    # Windows ZipArchive uses a DOS creator ID. Mark each central-directory
    # record as Unix so Finder honors the stored 0755 executable permissions.
    $reader = [System.IO.BinaryReader]::new($file, $utf8, $true)
    try {
        $file.Position = $file.Length - 22
        if ($reader.ReadUInt32() -ne 0x06054b50) { throw 'Unexpected ZIP end record.' }
        $file.Position += 6
        $count = $reader.ReadUInt16()
        $file.Position += 4
        $centralOffset = $reader.ReadUInt32()
        $file.Position = $centralOffset
        for ($index = 0; $index -lt $count; $index++) {
            $start = $file.Position
            if ($reader.ReadUInt32() -ne 0x02014b50) { throw 'Unexpected ZIP directory record.' }
            $file.Position = $start + 5
            $file.WriteByte(3)
            $file.Position = $start + 28
            $nameLength = $reader.ReadUInt16()
            $extraLength = $reader.ReadUInt16()
            $commentLength = $reader.ReadUInt16()
            $file.Position = $start + 46 + $nameLength + $extraLength + $commentLength
        }
    } finally { $reader.Dispose() }
} finally { $file.Dispose() }
