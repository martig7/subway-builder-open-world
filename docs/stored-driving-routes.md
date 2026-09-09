# Stored driving routes

Japan's native in-tile and cross-tile driving-route views now retrieve
precomputed geometry through the existing `map://paths/<city>/<pop>` adapter.
The renderer no longer builds a road graph for these requests. Driving time,
distance, mode choice and transit journeys are unchanged; these archives serve
the displayed driving line.

## Measured result

Built on richmpc from the existing Japan individual cross-demand package and
OSRM dataset `geofabrik-japan-8b9165a595130fbe-car-v6`.

| Archive set | Pop records | Unique stored records | Installed bytes |
| --- | ---: | ---: | ---: |
| Cross-tile | 33,553 | 31,880 | 202,749,411 |
| Native, all 47 prefectures | 602,807 | 410,395 | 1,747,155,622 |
| Total | 636,360 | 442,275 | 1,949,905,033 |

Identical records share one offset within an archive. Every pop still has its
own index entry. The build cache remains on the Runner; it is not installed.
OSRM found road geometry for 99.6% of records. There are 13 cross-tile and 2,615
native `NoRoute`/`NoSegment` results, explicitly stored as geometric fallbacks.
Those fallbacks are not claimed to follow roads or ferry services. Transport
errors fail the build and are never converted into successful route records.

The live game was reloaded with empty application route caches. Requests through
the actual native fetch adapter measured:

| Request | Time | Coordinates |
| --- | ---: | ---: |
| Previously inspected Tokyo–Kanagawa cross route | 19.3 ms | 1,173 |
| Long-distance cross road route | 29.1 ms | 49,305 |
| Reverse long-distance cross road route | 25.3 ms | 45,834 |
| Explicit geometric fallback | 3.0 ms | 13 |
| Three native routes | 2.0–2.8 ms | 159–547 |
| Cached repeat of the first cross route | 0.5 ms | 1,173 |

The previous isolated cold replay on richmpc took 11,086.7 ms: 1,590.2 ms decoding
roads, 9,201.9 ms constructing the graph, and 294.6 ms finding the path. Its graph
had 2,848,286 nodes and 6,352,172 directed edges. The old replay and new live check
ran on different hosts; they establish the eliminated work and successful live
latency, not a controlled hardware-normalized speedup. Disk caches were not
flushed. No production GC or heap snapshot was used.

Seven live records occupied 840,578 accounted cache bytes. City, camera, pause,
session, network counts, money, clock and renderer time origin matched before
and after the checks. Exact results are in
[`stored-driving-routes-results.json`](stored-driving-routes-results.json).

## Runtime and memory

The shared local map service exposes
`/<tile>/driving-routes/{native|cross}/<pop-id>`. Cross records live once, under
the World's initial tile; native records live under their corresponding tile.
The service binary-searches the index on disk, reads one gzip record, and serves
it as compressed JSON. It retains neither the full index nor a routing graph.

The renderer caches compact serialized records with an 8 MiB accounting limit
and 256-entry limit. Accounting includes UTF-16 string storage plus an allowance
per entry; this is a cache-payload budget, not an exact process-heap ceiling.
Only requested routes are decoded into coordinate arrays, owned by their views.
In-flight requests are bounded, shared between duplicate callers and cancelled
when the old session is disposed. Failed requests remain retryable. HTTP lookups
have a ten-second deadline. The operating system may independently cache disk
pages; the game does not parse the 1.95 GB archive collection at startup.

Stored road routes bypass the former 250 km display cutoff. Native and
cross-tile callers use one resolver. Other Worlds retain their existing behavior
until their definitions and generated artifacts enable stored geometry.

## Generation and publication

Run `map-creator/scripts/build_route_geometry.ps1` on the selected Runner after
demand routing and before building the consumer:

```powershell
./map-creator/scripts/build_route_geometry.ps1 `
  -DemandRoot prototype/japan/generated/demand `
  -OutputRoot prototype/japan/generated/routes `
  -DatasetId geofabrik-japan-8b9165a595130fbe-car-v6 `
  -OsrmBaseUrl http://127.0.0.1:5000 -Workers 16
```

This stdlib-only generator requests OSRM `overview=full&geometries=polyline6`.
Its SQLite cache keys include dataset identity and exact endpoints. Interrupted
builds resume from completed requests and verified package manifests. Changing
the OSRM dataset requires a new dataset identity. Changing demand invalidates
the corresponding package; changing train service does not.

`demand.routeGeometry: stored-driving-routes-v1` opts a World in. Consumer builds
verify every route artifact's size/hash and its originating demand hash. The
bundle embeds a manifest-derived revision used in request URLs, so rebuilding
geometry invalidates HTTP caches. Both the JavaScript installer and native
release packager include the archives. The JavaScript installer checks the
server's route capability and reports an outdated server explicitly.

The pilot artifacts are retained on richmpc at
`C:/Users/gianc/open-world-runs/stored-driving-routes-20260908` and locally in the
ignored `prototype/japan/generated/routes` directory.

## Format and validation

Each `.idx` starts with `OWRTIDX1`, little-endian uint32 version 1 and uint32
entry count. Sorted 32-byte entries contain a 16-byte SHA-256 pop-ID prefix,
uint64 byte offset, uint32 gzip length and reserved uint32 zero. The `.bin`
contains independent compressed JSON records. Generation rejects duplicate IDs,
hash-prefix collisions, unsupported IDs and records over 2 MiB. The server checks
index lengths, record bounds and route scope; unknown IDs return 404.

Tests cover both demand formats, record deduplication, failed-server versus
no-route handling, exact index lookup, invalid offsets, demand/hash mismatches,
both endpoint scopes, cache eviction, retry, request coalescing, geometry isolation
and session disposal. The published trimmed server was also exercised from the
game renderer to verify decompression and CORS headers.

Validation passed: 720 platform/regression tests, 6 Japan consumer tests,
20 native .NET tests and 3 route-generation Python tests.

Installed Japan manifest: `local.japan-open-world`; consumer: `prototype/japan/mod`.
All 96 installed route files were rehashed against their built counterparts.
Bundle hashes and timestamps matched. Shared service health returned HTTP 200,
`native-pmtiles-directory-v4` and `X-OpenWorld-Route-Archive: stored-driving-routes-v1`.
