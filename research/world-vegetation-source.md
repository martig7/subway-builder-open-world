# Worldwide vegetation overview source

Research date: 2026-09-05. Scope: actual worldwide vegetation for a recolorable map overview below zoom 10. This is source research; it does not establish that a runtime consumer was built or installed.

## Selected source

Use NASA GIBS `MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual`, pinned to `2023-01-01`. Its [official layer metadata](https://gibs.earthdata.nasa.gov/layer-metadata/v1.0/MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual.json) identifies the underlying dataset as MODIS Terra+Aqua MCD12Q1 version 061, yearly global 500 m land-cover classification. This is categorical land cover, with no relief shading. NASA's [Python example](https://nasa-gibs.github.io/gibs-api-docs/python-usage/) specifically demonstrates mapping this layer's RGB colors back to land-cover classes using its published colormap.

The [live WMTS capabilities](https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml), inspected on the research date, advertise worldwide bounds, `500m` tile matrix, PNG output, annual dates `2001-01-01/2024-01-01/P1Y`, and default date `2024-01-01`. Pinning 2023 avoids an implicit moving default.

## Download and size evidence

The following public, unauthenticated WMS request was fetched successfully on the research date: HTTP 200, `image/png`, **2,715,703 bytes** (2.59 MiB). Its PNG header confirms **8192 x 4096** pixels:

[Verified global 8192 x 4096 classification PNG](https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&LAYERS=MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual&CRS=EPSG:4326&STYLES=&WIDTH=8192&HEIGHT=4096&BBOX=-90,-180,90,180&TIME=2023-01-01)

The same request at 4096 x 2048 returned HTTP 200 and 781,776 bytes. These measured sizes describe the returned PNGs, not a promised permanent size. No downloaded images were persisted by this research task.

[Official GIBS WMS documentation](https://nasa-gibs.github.io/gibs-api-docs/access-basics/) documents the endpoint and WMS versions. With WMS 1.3.0 and `CRS=EPSG:4326`, `BBOX` uses **south, west, north, east** axis order.

For the intended implementation, four 8192 x 4096 requests can cover a global 16384 x 8192 grid. These quadrant requests are a proposed construction; only the global requests above were fetched during research.

| Quadrant | BBOX |
| --- | --- |
| Northwest | `0,-180,90,0` |
| Northeast | `0,0,90,180` |
| Southwest | `-90,-180,0,0` |
| Southeast | `-90,0,0,180` |

Derived angular cell size: 0.0439453125 degrees for global 8192 x 4096; 0.02197265625 degrees for global 16384 x 8192. These correspond to approximately 4.89 km and 2.45 km north-south at the equator. Longitude distance per cell decreases with latitude. These are requested overview grids, not the underlying product's 500 m resolution.

## Exact classification mapping

Use the [official colormap XML](https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_IGBP_Land_Cover_Type.xml), fetched successfully on the research date. Read `ColorMapEntry.sourceValue`; `LegendEntry.id` is a different zero-based identifier and must not be substituted for the class value.

| Source value | RGB | Classification | Include in vegetation mask |
| --- | --- | --- | --- |
| 1 | 33,138,33 | Evergreen needleleaf forest | Yes |
| 2 | 49,204,49 | Evergreen broadleaf forest | Yes |
| 3 | 152,204,49 | Deciduous needleleaf forest | Yes |
| 4 | 150,250,150 | Deciduous broadleaf forest | Yes |
| 5 | 141,186,141 | Mixed forest | Yes |
| 6 | 186,141,141 | Closed shrubland | Yes |
| 7 | 245,222,179 | Open shrubland | Yes |
| 8 | 218,235,157 | Woody savanna | Yes |
| 9 | 255,213,0 | Savanna | Yes |
| 10 | 240,185,103 | Grassland | Yes |
| 11 | 71,131,181 | Permanent wetland | Yes |
| 12 | 250,239,115 | Cropland | No |
| 13 | 255,0,0 | Urban/built-up | No |
| 14 | 153,147,86 | Cropland/natural vegetation mosaic | No |
| 15 | 255,255,255 | Permanent snow/ice | No |
| 16 | 191,191,189 | Barren | No |
| 0 or 17 | 134,202,227 | Water | No |
| 255 | 100,100,100 | Unclassified | No |
| No data | 0,0,0 with transparency | No data | No |

The mask policy above is the implementation decision: include classes 1–11 and exclude agriculture/mosaics, cities, bare land, snow, water, and no data. Because source class names can contain spaces, parse the XML structurally or preserve this explicit numerical mapping. Transparency must also be checked. Do not infer vegetation from green intensity: wetlands and grassland have deliberately nongreen source colors.

## Redistribution and attribution

NASA's [Data Use and Citation Guidance](https://www.earthdata.nasa.gov/engage/open-data-services-software/data-use-policy) says data from NASA-led missions are CC0 unless explicitly marked with a restriction, and permits reproduction and distribution of uncopyrighted NASA material without further permission. It requests source acknowledgment and prohibits implying NASA endorsement. The [GIBS introduction and acknowledgment guidance](https://nasa-gibs.github.io/gibs-api-docs/) likewise promotes open sharing and requests acknowledgment of GIBS and ESDIS.

Suggested concise attribution: **Vegetation overview derived from NASA MODIS MCD12Q1 v061 (2023), supplied through NASA GIBS / ESDIS.** Link it to the official layer metadata and retain the request URLs, date, dimensions, class policy, palette, and downloaded checksums in build provenance. If modified data are distributed, identify the overview as resampled and simplified.

## Interpretation and implementation limits

The recommended output is a simplified vegetation mask recolored with the native park theme; it is not a database of parks or protected areas. Classification reflects annual satellite-derived land cover, not parcel boundaries or a current-year survey.

A WMS overview is a visualization resampled from source imagery. Do not assume every coarse cell is the statistical majority of all 500 m source cells: no such aggregation guarantee was established here. Point sampling and overview selection can omit narrow features, alias fragmented farmland/forest edges, and miss small islands. Simplification adds further geometric approximation. This is suitable for the requested broad overview; local land-use detail should take over at higher zoom.

Use exact palette matches and count unknown opaque colors before polygonization. If a response introduces interpolated colors, do not silently assign the nearest green hue; use a nearest-neighbor access path or explicitly documented classification conversion. Merge same-mask cells, simplify after classification, retain polygon holes, and split dateline geometry. A query for a date outside the available interval should fail validation rather than silently accepting empty imagery.

## Alternatives examined

- [JRC GLC2000](https://forobs.jrc.ec.europa.eu/glc2000/data) offers a compact worldwide categorical product, listed as approximately 33 MB, including a [direct TIFF ZIP](https://forobs.jrc.ec.europa.eu/data/products/glc2000/glc2000_v1_1_Tiff.zip). However, its [specific redistribution terms](https://forobs.jrc.ec.europa.eu/glc2000/disclaimer) require written JRC permission even for noncommercial redistribution; it does not meet the requirement for immediate redistributable source data.
- [NASA NEO](https://science.nasa.gov/earth/nasa-earth-observations-neo/) was decommissioned in September 2026. Its old land-cover download page redirects to the official retirement announcement. Do not build a new downloader against the historical NEO interface.
- [EarthEnv consensus land cover](https://www.earthenv.org/landcover) is distributed under CC BY-NC 4.0. Its noncommercial restriction makes it less suitable than the NASA source for a generally redistributable mod pipeline.
