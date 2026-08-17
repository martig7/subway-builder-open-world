param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [string]$BindHost = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 8798,
    [switch]$CheckOnly,
    [string]$CheckTile
)

$ErrorActionPreference = 'Stop'
$script:ServerVersion = 'native-pmtiles-directory-v2'

function Read-UInt64LE {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToUInt64($Bytes, $Offset)
}

function Read-Int32LE {
    param([byte[]]$Bytes, [int]$Offset)
    return [BitConverter]::ToInt32($Bytes, $Offset)
}

function Read-FileRange {
    param(
        [System.IO.FileStream]$Stream,
        [UInt64]$Offset,
        [UInt64]$Length
    )
    if ($Length -gt [int]::MaxValue) { throw "PMTiles range is too large: $Length bytes" }
    $buffer = New-Object byte[] ([int]$Length)
    [void]$Stream.Seek([int64]$Offset, [System.IO.SeekOrigin]::Begin)
    $readTotal = 0
    while ($readTotal -lt $buffer.Length) {
        $read = $Stream.Read($buffer, $readTotal, $buffer.Length - $readTotal)
        if ($read -le 0) { throw "Unexpected end of PMTiles archive at offset $Offset" }
        $readTotal += $read
    }
    return ,$buffer
}

function Expand-PmtilesBytes {
    param(
        [byte[]]$Bytes,
        [byte]$Compression,
        [string]$Description
    )
    # PMTiles compression enum: 1 = none, 2 = gzip, 3 = brotli.
    if ($Compression -eq 1) { return ,$Bytes }
    if ($Compression -eq 3) {
        $brotliType = [type]::GetType('System.IO.Compression.BrotliStream, System.IO.Compression')
        if (-not $brotliType) {
            throw "Brotli-compressed $Description requires a newer .NET runtime"
        }
    }
    if ($Compression -ne 2 -and $Compression -ne 3) {
        throw "Unsupported PMTiles compression $Compression for $Description"
    }

    $input = [System.IO.MemoryStream]::new($Bytes, $false)
    $output = [System.IO.MemoryStream]::new()
    $decoder = $null
    try {
        if ($Compression -eq 2) {
            $decoder = [System.IO.Compression.GZipStream]::new(
                $input,
                [System.IO.Compression.CompressionMode]::Decompress
            )
        } else {
            $decoder = [Activator]::CreateInstance(
                $brotliType,
                @($input, [System.IO.Compression.CompressionMode]::Decompress)
            )
        }
        $decoder.CopyTo($output)
        return ,$output.ToArray()
    } finally {
        if ($decoder) { $decoder.Dispose() }
        $output.Dispose()
        $input.Dispose()
    }
}

function Read-PmtilesVarint {
    param(
        [byte[]]$Bytes,
        [ref]$Index
    )
    [UInt64]$value = 0
    [int]$shift = 0
    while ($true) {
        if ($Index.Value -ge $Bytes.Length) { throw 'Truncated PMTiles directory varint' }
        [byte]$current = $Bytes[$Index.Value]
        $Index.Value++
        $value = $value -bor ([UInt64]($current -band 0x7f) -shl $shift)
        if (($current -band 0x80) -eq 0) { return $value }
        $shift += 7
        if ($shift -gt 63) { throw 'PMTiles directory varint is too large' }
    }
}

function Read-PmtilesDirectory {
    param([byte[]]$Bytes)
    [int]$index = 0
    [UInt64]$count = Read-PmtilesVarint -Bytes $Bytes -Index ([ref]$index)
    if ($count -gt 10000000) { throw "PMTiles directory has too many entries: $count" }

    # PMTiles v3 stores each directory column contiguously: all tile IDs,
    # followed by all run lengths, all lengths, and all offsets.  It is not an
    # entry-by-entry tuple stream.
    $tileIds = New-Object UInt64[] ([int]$count)
    $runLengths = New-Object UInt64[] ([int]$count)
    $lengths = New-Object UInt64[] ([int]$count)
    $encodedOffsets = New-Object UInt64[] ([int]$count)
    for ($entryIndex = 0; $entryIndex -lt [int]$count; $entryIndex++) {
        $tileIds[$entryIndex] = Read-PmtilesVarint -Bytes $Bytes -Index ([ref]$index)
    }
    for ($entryIndex = 0; $entryIndex -lt [int]$count; $entryIndex++) {
        $runLengths[$entryIndex] = Read-PmtilesVarint -Bytes $Bytes -Index ([ref]$index)
    }
    for ($entryIndex = 0; $entryIndex -lt [int]$count; $entryIndex++) {
        $lengths[$entryIndex] = Read-PmtilesVarint -Bytes $Bytes -Index ([ref]$index)
        if ($lengths[$entryIndex] -eq 0) { throw 'PMTiles directory entry has zero length' }
    }
    for ($entryIndex = 0; $entryIndex -lt [int]$count; $entryIndex++) {
        $encodedOffsets[$entryIndex] = Read-PmtilesVarint -Bytes $Bytes -Index ([ref]$index)
    }

    $entries = New-Object System.Collections.Generic.List[object]
    [UInt64]$previousTileId = 0
    [UInt64]$previousOffset = 0
    [UInt64]$previousLength = 0
    for ($entryIndex = 0; $entryIndex -lt [int]$count; $entryIndex++) {
        [UInt64]$tileId = $previousTileId + $tileIds[$entryIndex]
        [UInt64]$runLength = $runLengths[$entryIndex]
        [UInt64]$length = $lengths[$entryIndex]
        # An encoded offset of zero means the blob follows the previous blob;
        # otherwise the stored value is the absolute offset plus one.
        [UInt64]$offset = if ($encodedOffsets[$entryIndex] -eq 0) {
            $previousOffset + $previousLength
        } else {
            $encodedOffsets[$entryIndex] - 1
        }
        $entries.Add([pscustomobject]@{
            TileId = $tileId
            RunLength = $runLength
            Length = $length
            Offset = $offset
        })
        $previousTileId = $tileId
        $previousOffset = $offset
        $previousLength = $length
    }
    return ,$entries.ToArray()
}

function Open-PmtilesArchive {
    param([string]$Path)
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::ReadWrite
    )
    try {
        $header = Read-FileRange -Stream $stream -Offset 0 -Length 127
        $magic = [System.Text.Encoding]::ASCII.GetString($header, 0, 7)
        if ($magic -ne 'PMTiles' -or $header[7] -ne 3) {
            throw "Unsupported PMTiles archive header in $Path"
        }
        # PMTiles v3 header byte 96 is clustered, followed by internal
        # compression, tile compression, and tile type at 97-99.
        $internalCompression = $header[97]
        $rootOffset = Read-UInt64LE $header 8
        $rootLength = Read-UInt64LE $header 16
        $leafOffset = Read-UInt64LE $header 40
        $tileOffset = Read-UInt64LE $header 56
        $tileLength = Read-UInt64LE $header 64
        if ($rootOffset + $rootLength -gt [UInt64]$stream.Length) { throw "PMTiles root directory exceeds $Path" }
        if ($leafOffset + (Read-UInt64LE $header 48) -gt [UInt64]$stream.Length) { throw "PMTiles leaf directory exceeds $Path" }
        if ($tileOffset + $tileLength -gt [UInt64]$stream.Length) { throw "PMTiles tile data exceeds $Path" }

        $rootCompressed = Read-FileRange -Stream $stream -Offset $rootOffset -Length $rootLength
        $root = Read-PmtilesDirectory (Expand-PmtilesBytes $rootCompressed $internalCompression 'root directory')
        return [pscustomobject]@{
            Path = $Path
            Stream = $stream
            InternalCompression = $internalCompression
            TileCompression = $header[98]
            TileType = $header[99]
            LeafOffset = $leafOffset
            LeafLength = Read-UInt64LE $header 48
            TileOffset = $tileOffset
            TileLength = $tileLength
            Root = $root
            LeafCache = @{}
        }
    } catch {
        $stream.Dispose()
        throw
    }
}

function Find-PmtilesRootEntry {
    param([object[]]$Directory, [UInt64]$TileId)
    [int]$low = 0
    [int]$high = $Directory.Count - 1
    $candidate = $null
    while ($low -le $high) {
        $middle = [int](($low + $high) / 2)
        $entry = $Directory[$middle]
        if ($entry.TileId -le $TileId) {
            $candidate = $entry
            $low = $middle + 1
        } else {
            $high = $middle - 1
        }
    }
    if (-not $candidate) { return $null }
    if ($candidate.RunLength -eq 0) { return $candidate }
    if ($TileId -lt $candidate.TileId + $candidate.RunLength) { return $candidate }
    return $null
}

function Find-PmtilesLeafEntry {
    param([object[]]$Directory, [UInt64]$TileId)
    [int]$low = 0
    [int]$high = $Directory.Count - 1
    while ($low -le $high) {
        $middle = [int](($low + $high) / 2)
        $entry = $Directory[$middle]
        if ($TileId -lt $entry.TileId) {
            $high = $middle - 1
        } elseif ($TileId -ge $entry.TileId + $entry.RunLength) {
            $low = $middle + 1
        } else {
            return $entry
        }
    }
    return $null
}

function Get-PmtilesEntry {
    param($Archive, [UInt64]$TileId)
    $rootEntry = Find-PmtilesRootEntry -Directory $Archive.Root -TileId $TileId
    if (-not $rootEntry) { return $null }
    if ($rootEntry.RunLength -ne 0) { return $rootEntry }

    $cacheKey = "$($rootEntry.Offset):$($rootEntry.Length)"
    if (-not $Archive.LeafCache.ContainsKey($cacheKey)) {
        $leafBytes = Read-FileRange -Stream $Archive.Stream -Offset ($Archive.LeafOffset + $rootEntry.Offset) -Length $rootEntry.Length
        $Archive.LeafCache[$cacheKey] = Read-PmtilesDirectory (Expand-PmtilesBytes $leafBytes $Archive.InternalCompression 'leaf directory')
    }
    return Find-PmtilesLeafEntry -Directory $Archive.LeafCache[$cacheKey] -TileId $TileId
}

function Get-HilbertIndex {
    param([int]$Zoom, [int]$X, [int]$Y)
    [int]$size = 1 -shl $Zoom
    [int]$xValue = $X
    [int]$yValue = $Y
    [UInt64]$distance = 0
    for ([int]$step = [int]($size / 2); $step -gt 0; $step = [int]($step / 2)) {
        $xBit = if (($xValue -band $step) -ne 0) { 1 } else { 0 }
        $yBit = if (($yValue -band $step) -ne 0) { 1 } else { 0 }
        $distance += [UInt64]$step * [UInt64]$step * [UInt64]((3 * $xBit) -bxor $yBit)
        if ($yBit -eq 0) {
            if ($xBit -eq 1) {
                $xValue = $size - 1 - $xValue
                $yValue = $size - 1 - $yValue
            }
            $swap = $xValue
            $xValue = $yValue
            $yValue = $swap
        }
    }
    return $distance
}

function Convert-ZxyToPmtilesId {
    param([int]$Zoom, [int]$X, [int]$Y)
    [UInt64]$zoomBase = (([UInt64]1 -shl (2 * $Zoom)) - 1) / 3
    return $zoomBase + (Get-HilbertIndex -Zoom $Zoom -X $X -Y $Y)
}

function Normalize-PmtilesX {
    param([int]$Zoom, [int]$X)
    [Int64]$worldSize = 1 -shl $Zoom
    [Int64]$normalized = $X % $worldSize
    if ($normalized -lt 0) { $normalized += $worldSize }
    return [int]$normalized
}

function Get-PmtilesTile {
    param($Archive, [int]$Zoom, [int]$X, [int]$Y)
    $tileId = Convert-ZxyToPmtilesId -Zoom $Zoom -X $X -Y $Y
    $entry = Get-PmtilesEntry -Archive $Archive -TileId $tileId
    if (-not $entry -or $entry.Length -eq 0) { return $null }
    if ($entry.Offset + $entry.Length -gt $Archive.TileLength) { throw "PMTiles tile entry exceeds tile data in $($Archive.Path)" }
    $compressed = Read-FileRange -Stream $Archive.Stream -Offset ($Archive.TileOffset + $entry.Offset) -Length $entry.Length
    return Expand-PmtilesBytes $compressed $Archive.TileCompression 'tile data'
}

function Send-Bytes {
    param(
        [System.Net.HttpListenerContext]$Context,
        [byte[]]$Bytes,
        [int]$StatusCode = 200,
        [string]$ContentType = 'application/octet-stream'
    )
    $response = $Context.Response
    try {
        $response.StatusCode = $StatusCode
        $response.ContentType = $ContentType
        $response.ContentLength64 = $Bytes.Length
        $response.Headers['Access-Control-Allow-Origin'] = '*'
        $response.Headers['Access-Control-Allow-Headers'] = 'Range'
        $response.Headers['Cache-Control'] = 'public, max-age=3600'
        $response.Headers['X-PMTiles-Server-Version'] = $script:ServerVersion
        if ($Context.Request.HttpMethod -ne 'HEAD' -and $Bytes.Length -gt 0) {
            $response.OutputStream.Write($Bytes, 0, $Bytes.Length)
        }
    } finally {
        try { $response.Close() } catch {}
    }
}

function Test-ExpectedClientDisconnect {
    param([System.Exception]$Exception)
    $current = $Exception
    while ($current) {
        try {
            if ($current -is [System.Net.HttpListenerException] -and $current.ErrorCode -in @(64, 995, 1229)) {
                return $true
            }
        } catch {}
        if ($current.Message -match '(?i)network name is no longer available|forcibly closed|connection.*(closed|reset|aborted)|operation.*aborted|remote host.*closed|broken pipe') {
            return $true
        }
        $current = $current.InnerException
    }
    return $false
}

$resolvedRoot = [System.IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) { throw "Tile root does not exist: $resolvedRoot" }

$archives = @{}
foreach ($directory in @(Get-ChildItem -LiteralPath $resolvedRoot -Directory)) {
    $archivePath = Join-Path $directory.FullName 'tiles.pmtiles'
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $archives[$directory.Name] = Open-PmtilesArchive -Path $archivePath
    }
}
foreach ($archiveFile in @(Get-ChildItem -LiteralPath $resolvedRoot -Filter '*.pmtiles' -File)) {
    if (-not $archives.ContainsKey($archiveFile.BaseName)) {
        $archives[$archiveFile.BaseName] = Open-PmtilesArchive -Path $archiveFile.FullName
    }
}
if ($archives.Count -eq 0) { throw "No PMTiles archives found under $resolvedRoot" }

if ($CheckOnly) {
    if (-not $CheckTile) { throw '-CheckTile is required with -CheckOnly (archive/z/x/y)' }
    $checkParts = $CheckTile.Trim('/').Split('/')
    if ($checkParts.Count -ne 4) { throw "Invalid check tile: $CheckTile" }
    $checkArchive = $archives[$checkParts[0]]
    if (-not $checkArchive) { throw "Unknown check archive: $($checkParts[0])" }
    [int]$checkZoom = 0; [int]$checkX = 0; [int]$checkY = 0
    if (-not [int]::TryParse($checkParts[1], [ref]$checkZoom) -or
        -not [int]::TryParse($checkParts[2], [ref]$checkX) -or
        -not [int]::TryParse($checkParts[3], [ref]$checkY)) {
        throw "Invalid check tile coordinates: $CheckTile"
    }
    if ($checkZoom -lt 0 -or $checkZoom -gt 30) { throw "Invalid check tile zoom: $CheckTile" }
    $checkX = Normalize-PmtilesX -Zoom $checkZoom -X $checkX
    $checkBytes = Get-PmtilesTile -Archive $checkArchive -Zoom $checkZoom -X $checkX -Y $checkY
    [pscustomobject]@{
        Archive = $checkParts[0]
        Zoom = $checkZoom
        X = $checkX
        Y = $checkY
        InternalCompression = $checkArchive.InternalCompression
        TileCompression = $checkArchive.TileCompression
        TileType = $checkArchive.TileType
        Length = if ($null -eq $checkBytes) { 0 } else { $checkBytes.Length }
        FirstBytes = if ($null -eq $checkBytes) { @() } else { @($checkBytes[0..([Math]::Min(15, $checkBytes.Length - 1))]) }
    } | ConvertTo-Json -Compress
    foreach ($archive in $archives.Values) { $archive.Stream.Dispose() }
    return
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://${BindHost}:${Port}/")
$listener.Start()
Write-Output "Native PMTiles server listening at http://${BindHost}:${Port}/"
Write-Output "Serving $($archives.Count) archive(s) from $resolvedRoot"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $request = $context.Request
            if ($request.HttpMethod -eq 'OPTIONS') {
                Send-Bytes -Context $context -Bytes ([Text.Encoding]::UTF8.GetBytes('ok')) -ContentType 'text/plain'
                continue
            }
            $path = [Uri]::UnescapeDataString($request.Url.AbsolutePath).Trim('/')
            if ($path -eq '_health') {
                Send-Bytes -Context $context -Bytes ([Text.Encoding]::UTF8.GetBytes('ok')) -ContentType 'text/plain'
                continue
            }

            $parts = if ($path) { $path.Split('/') } else { @() }
            if ($parts.Count -ne 4) {
                Send-Bytes -Context $context -Bytes ([Text.Encoding]::UTF8.GetBytes('Not found')) -StatusCode 404 -ContentType 'text/plain'
                continue
            }
            $tileId = $parts[0]
            if (-not $archives.ContainsKey($tileId)) {
                Send-Bytes -Context $context -Bytes ([Text.Encoding]::UTF8.GetBytes('Unknown tile')) -StatusCode 404 -ContentType 'text/plain'
                continue
            }
            [int]$zoom = 0; [int]$x = 0; [int]$y = 0
            $validZoom = [int]::TryParse($parts[1], [ref]$zoom)
            $validX = [int]::TryParse($parts[2], [ref]$x)
            $ySegment = $parts[3]
            if ($ySegment -notmatch '^(-?[0-9]+)\.mvt$') {
                $validY = $false
            } else {
                $validY = [int]::TryParse($Matches[1], [ref]$y)
            }
            if (-not $validZoom -or -not $validX -or -not $validY -or $zoom -lt 0 -or $zoom -gt 30) {
                Send-Bytes -Context $context -Bytes ([Text.Encoding]::UTF8.GetBytes('Invalid tile coordinates')) -StatusCode 400 -ContentType 'text/plain'
                continue
            }
            $limit = [int](1 -shl $zoom)
            # Slippy-map x coordinates wrap horizontally at every zoom. A
            # world view commonly requests x=1 at z0 (and negative/overflowing
            # x values while panning), so rejecting those requests returns
            # plaintext to the vector-tile parser and produces "Unimplemented
            # type: 4". Y does not wrap; an off-world row is simply empty.
            $x = Normalize-PmtilesX -Zoom $zoom -X $x
            if ($y -lt 0 -or $y -ge $limit) {
                Send-Bytes -Context $context -Bytes ([byte[]]::new(0)) -StatusCode 204 -ContentType 'application/vnd.mapbox-vector-tile'
                continue
            }
            $tile = Get-PmtilesTile -Archive $archives[$tileId] -Zoom $zoom -X $x -Y $y
            if ($null -eq $tile) {
                Send-Bytes -Context $context -Bytes ([byte[]]::new(0)) -StatusCode 204 -ContentType 'application/vnd.mapbox-vector-tile'
                continue
            }
            Send-Bytes -Context $context -Bytes $tile -ContentType 'application/vnd.mapbox-vector-tile'
        } catch {
            # Browsers routinely cancel tile requests while the viewport is
            # changing. The client-disconnect exception is expected and should
            # not spam the console or trigger a second write to a dead socket.
            if (-not (Test-ExpectedClientDisconnect -Exception $_.Exception)) {
                try { Write-Warning "Tile request failed: $($_.Exception.Message)" } catch {}
                try {
                    Send-Bytes -Context $context -Bytes ([Text.Encoding]::UTF8.GetBytes('Tile server error')) -StatusCode 500 -ContentType 'text/plain'
                } catch {}
            }
        }
    }
} finally {
    foreach ($archive in $archives.Values) { $archive.Stream.Dispose() }
    $listener.Stop()
    $listener.Close()
}
