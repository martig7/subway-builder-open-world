[CmdletBinding()]
param(
    [string]$RawDir = (Join-Path $PSScriptRoot '..\raw-data\estat\od'),
    [switch]$SkipEmploymentMesh,
    [switch]$ListOnly
)

$ErrorActionPreference = 'Stop'

$municipalityOd = [ordered]@{
    id = 'census_2020_municipality_od_combined'
    title = '2020 Census Table 6-1: municipality origin/destination, commuting plus schooling'
    url = 'https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000032214472'
    file = '2020-census-table-6-1-municipality-od-combined.xlsx'
}

$meshProducts = @(
    [ordered]@{
        id = 'census_2020_250m_origin_marginals'
        title = '2020 Census 250m mesh: population movement, employment status, and workplace/schoolplace'
        catalogUrl = 'https://www.e-stat.go.jp/gis/statmap-search?aggregateUnit=Q&page=1&serveyId=Q002005112020&statsId=T001109&toukeiCode=00200521&toukeiYear=2020&type=1'
        statsId = 'T001109'
        directory = '2020-census-250m-origin-marginals'
    }
)

if (-not $SkipEmploymentMesh) {
    $meshProducts += [ordered]@{
        id = 'economic_census_2021_500m_destination_capacity'
        title = '2021 Economic Census 500m mesh: establishment and employee counts by industry'
        catalogUrl = 'https://www.e-stat.go.jp/gis/statmap-search?aggregateUnit=H&datum=2011&page=1&serveyId=H002005112021&statsId=T001162&toukeiCode=00200553&toukeiYear=2021&type=1'
        statsId = 'T001162'
        directory = '2021-economic-census-500m-destination-capacity'
    }
}

function Get-CatalogPageCount {
    param([string]$Html)

    $matches = [regex]::Matches($Html, '(\d+)\s*/\s*(\d+)ページ')
    if ($matches.Count -eq 0) {
        return 1
    }

    return ($matches | ForEach-Object { [int]$_.Groups[2].Value } | Measure-Object -Maximum).Maximum
}

function Get-MeshDownloadLinks {
    param(
        [string]$CatalogUrl,
        [string]$StatsId
    )

    $searchDetailUrl = $CatalogUrl.Replace('/gis/statmap-search?', '/gis/statmap-search/search_detail?') + '&download_disp_flg=1&mesh_data_flg=1'
    $firstPage = (Invoke-WebRequest -Uri $searchDetailUrl).Content | ConvertFrom-Json
    $pageCount = Get-CatalogPageCount -Html $firstPage.paginate
    $linksByCode = @{}

    for ($page = 1; $page -le $pageCount; $page += 1) {
        $pageUrl = $searchDetailUrl -replace '(?<=[?&])page=\d+', "page=$page"
        $response = if ($page -eq 1) { $firstPage } else { (Invoke-WebRequest -Uri $pageUrl).Content | ConvertFrom-Json }
        $pattern = 'href="(?<path>[^\"]*/gis/statmap-search/data\?[^\"]*statsId=' + [regex]::Escape($StatsId) + '[^\"]*code=(?<code>\d+)[^\"]*downloadType=2[^\"]*)"'

        foreach ($match in [regex]::Matches($response.detail, $pattern)) {
            $code = $match.Groups['code'].Value
            $path = [System.Net.WebUtility]::HtmlDecode($match.Groups['path'].Value)
            $linksByCode[$code] = "https://www.e-stat.go.jp$path"
        }
    }

    if ($linksByCode.Count -eq 0) {
        throw "No CSV download links were found for statsId $StatsId. e-Stat may have changed the catalog markup."
    }

    return $linksByCode.GetEnumerator() |
        Sort-Object { [int]$_.Key } |
        ForEach-Object { [PSCustomObject]@{ code = $_.Key; url = $_.Value } }
}

function Get-FileRecord {
    param(
        [string]$FilePath,
        [string]$SourceUrl,
        [string]$ProductId,
        [string]$Code = $null
    )

    $item = Get-Item -LiteralPath $FilePath
    return [ordered]@{
        productId = $ProductId
        code = $Code
        file = $item.Name
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        sourceUrl = $SourceUrl
    }
}

if ($ListOnly) {
    Write-Host "Municipality OD workbook: $($municipalityOd.url)"
    foreach ($product in $meshProducts) {
        $links = Get-MeshDownloadLinks -CatalogUrl $product.catalogUrl -StatsId $product.statsId
        Write-Host "$($product.id): $($links.Count) first-level mesh ZIP archives"
        $links | ForEach-Object { Write-Host "  $($_.code)  $($_.url)" }
    }
    return
}

$rawRoot = [System.IO.Path]::GetFullPath($RawDir)
New-Item -ItemType Directory -Force -Path $rawRoot | Out-Null
$files = [System.Collections.Generic.List[object]]::new()

$municipalityPath = Join-Path $rawRoot $municipalityOd.file
if (-not (Test-Path -LiteralPath $municipalityPath)) {
    Write-Host "Downloading $($municipalityOd.title)"
    Invoke-WebRequest -Uri $municipalityOd.url -OutFile $municipalityPath
} else {
    Write-Host "Keeping existing $($municipalityOd.file)"
}
$files.Add((Get-FileRecord -FilePath $municipalityPath -SourceUrl $municipalityOd.url -ProductId $municipalityOd.id))

foreach ($product in $meshProducts) {
    $productDirectory = Join-Path $rawRoot $product.directory
    New-Item -ItemType Directory -Force -Path $productDirectory | Out-Null
    $links = Get-MeshDownloadLinks -CatalogUrl $product.catalogUrl -StatsId $product.statsId
    Write-Host "Preparing $($product.title): $($links.Count) first-level mesh ZIP archives"

    foreach ($link in $links) {
        # The catalog labels these as CSV, but the e-Stat endpoint returns a ZIP
        # archive containing the tabular text file and its metadata.
        $fileName = "$($product.id)-M$($link.code).zip"
        $filePath = Join-Path $productDirectory $fileName
        if (-not (Test-Path -LiteralPath $filePath)) {
            Write-Host "  Downloading M$($link.code)"
            Invoke-WebRequest -Uri $link.url -OutFile $filePath
        }
        $files.Add((Get-FileRecord -FilePath $filePath -SourceUrl $link.url -ProductId $product.id -Code $link.code))
    }
}

$manifest = [ordered]@{
    schemaVersion = '1.0.0'
    generatedAt = [DateTime]::UtcNow.ToString('o')
    purpose = 'Inputs for a synthetic building-level OD model. Observed ODs remain municipality-to-municipality; mesh data are allocation constraints.'
    observedFlow = [ordered]@{
        dataset = $municipalityOd.title
        geography = 'Usual-residence municipality to workplace/school municipality'
        sourceUrl = $municipalityOd.url
    }
    products = @($municipalityOd) + $meshProducts
    files = @($files)
}

$manifestPath = Join-Path $rawRoot 'od-preparation.manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Host "Wrote $manifestPath"
