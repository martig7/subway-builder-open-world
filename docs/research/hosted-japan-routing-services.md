# Hosted routing options for the Japan recompute

Research date: 2026-09-04

Scope: production services capable of calculating approximately **404,989
deduplicated route searches** (the earlier reuse estimate) or **641,131 direct
cohort routes** for Japan. The latest workload inventory contains **401,015
unique, non-self native OD pairs across 219,315 origins**, plus **1,517
cross-tile searches**. Only first-party vendor documentation is used.

## Outcome

The best concrete self-service option is now **LocationIQ Growth Plus**. The
measured fanout is small (mean 1.828 destinations/origin, median 1, p90 4, max
48), and LocationIQ accepts up to 25 coordinates with selectable matrix sources
and destinations. Packing one origin with up to 24 destinations requires
**219,339 native matrix calls**; adding 1,517 cross-tile searches yields
**220,856 total requests**. At the plan's 30 requests/second, the raw floor is
**2.05 hours** and a realistic run allowance is roughly **2.5-4 hours**. The
entire run fits comfortably within its 7.5-million-request monthly allowance for
**$500 billed monthly**. Paid customers may cache request-response pairs while
subscribed and retain API output permanently. [Routing syntax and 25-coordinate
limit](https://docs.locationiq.com/docs/routing-api), [selectable Matrix sources
and destinations](https://docs.locationiq.com/docs/matrix-api), [monthly pricing,
rate limits, and caching](https://locationiq.com/pricing)

LocationIQ **Business Plus** costs **$950 billed monthly** and raises throughput
to 40 requests/second, shortening the raw matrix floor to **1.53 hours**. That
31-minute theoretical saving is unlikely to justify another $450 for a one-off
run unless the pilot shows Growth Plus cannot sustain its advertised ceiling.

**Geoapify Custom/dedicated** remains the strongest licensing fallback. It
explicitly permits storing routing results, offers an unmetered plan from
$860/month, and documents roughly 20 routing requests/second per dedicated
server. Packing the measured fanout into one-source matrices takes about
**220,832 requests** (219,315 native matrices plus 1,517 cross-tile searches),
or a **3.07-hour** raw floor. [Pricing and dedicated-server capacity](https://www.geoapify.com/pricing/),
[matrix limits and billing](https://apidocs.geoapify.com/docs/route-matrix/),
[storage policy](https://www.geoapify.com/products-and-services/)

The public Project OSRM endpoint is a demo, not bulk production infrastructure.
The project explicitly disallows excessive use, offers no guarantees, and may
withdraw access. It should remain limited to small validation samples.
[OSRM demo policy](https://github.com/Project-OSRM/osrm-backend/wiki/Api-usage-policy)

## What "provider caching" does and does not buy us

Hosted routers are fast mainly because they keep a prepared road graph in memory
and use routing accelerators such as contraction hierarchies or multilevel
partitioning. This is different from caching a response for a particular origin
and destination. None of the reviewed vendors promises free or discounted cache
hits for repeated route URLs; their pricing counts each request or matrix element.

Our existing deduplication is therefore the important cache: it reduces 641,131
cohort records to roughly 405,000 unique searches. The measured native subset is
401,015 non-self OD pairs. Results should be persisted locally after calculation,
but only with a vendor whose terms permit that.

The measured grouping resolves the earlier matrix uncertainty: 219,315 origins
have mean fanout 1.828, median 1, p90 4, and maximum 48. A LocationIQ request can
carry one origin and 24 destinations, so only the few origins above 24 need a
second request. This produces 219,339 matrix requests for all 401,015 native
pairs. It is efficient in **HTTP request count**, even though it does not reduce
the number of OD cells calculated. The 1,517 cross-tile searches remain direct
calls, producing 220,856 total LocationIQ requests.

All elapsed estimates below are rate-limit floors. They assume a two-point route
costs one request, the client holds the documented ceiling continuously, and
there are no retries, throttling, daily quotas, queueing, or integration time.

## Provider comparison

| Provider | Production volume and route features | Direct-call time floor: 404,989 / 641,131 | Approximate public price | Can retain compiled results? | Suitability |
| --- | --- | ---: | ---: | --- | --- |
| **LocationIQ Growth Plus** | 7.5 million requests/month and 30 requests/s. Matrix accepts 25 coordinates and selectable source/destination indices. Measured packing gives 220,856 total requests. | Direct calls: **3.75 h / 5.94 h**. Measured matrix plan: **2.05 h raw**, roughly **2.5-4 h operational**. | **$500 billed monthly** | **Yes**, while a paid subscription remains active; output itself may be stored forever. | **Best concrete option.** It is OSRM-shaped, self-service, inexpensive, and the measured job fits with large quota headroom. |
| **LocationIQ Business Plus** | 30 million requests/month and 40 requests/s; same matrix packing. | Direct calls: **2.81 h / 4.45 h**. Measured matrix plan: **1.53 h raw**. | **$950 billed monthly** (or $9,500 billed yearly). | **Yes**, under the same policy. | Only worthwhile if a pilot shows a material operational advantage over Growth Plus; theoretical saving is about 31 minutes. |
| **Geoapify Custom** | Unmetered; dedicated server documents about 20 routing requests/s. Route Matrix returns up to 1,000 cells/request. Measured packing gives 220,832 requests. | Direct calls: **5.6 h / 8.9 h**. Measured matrix plan: **3.07 h raw**. | From **$860/month**; one dedicated server is also described as EUR700/month plus EUR200 setup. | **Yes.** Geoapify explicitly permits caching, storing, and redistributing service results with required attribution. | **Best licensing fallback.** Ask for a one-month dedicated endpoint and confirm sustained Matrix throughput and Japan automobile profile. |
| **Geoapify API 250** | 250,000 credits/day, up to 30 requests/s. For a 1xN matrix, baseline billing is N credits, so measured matrix packing still costs about **401,015 native credits**, plus at least 1,517 cross-route credits and long-distance surcharges. | HTTP floor for measured packing: **2.04 h**, but baseline credits require **2 daily quota windows**. | **$609/month** | **Yes.** | Matrix packing cuts request overhead, not baseline credits. Geoapify documents a 0.5 batch multiplier; if Matrix batch jobs are supported for this workflow, baseline would fall to about 201,266 credits, but confirm batch availability and surcharge treatment before relying on a one-day run. |
| **MapMap hosted OSRM-compatible API** | Worldwide hosted routing; genuine OSRM-compatible `GET /route/v1/...`; self-serve keys are limited to 60 requests/min. Matrix supports 10,000 cells/request and bills per 25 cells. | Route calls: **112.5 h / 178.1 h** (**4.7 / 7.4 days**). Matrix packing could be much faster but depends on OD structure. | With the Starter plan and published overage, about **GBP126.50 / GBP244.57**; Growth is GBP299/month for 2M calls. | Terms contain no express route-result retention ban found in this review; OSM attribution is required. Confirm permanent redistribution before purchase. | Technically easy and inexpensive, but the self-serve one-request/second ceiling makes direct calls slow. Ask for a temporary higher rate. |
| **GraphHopper Premium** | 50,000 credits/day, 10 requests/s, 1,000 credits/min. A normal 2–10 point route is one credit. | Raw **11.2 h / 17.8 h**, but daily quota makes it at least **9 / 13 days**. | **EUR479/month** | **No for this use under standard terms.** Only temporary client caching is allowed; mass download requires a custom package. | Custom contract could work, but the published Premium plan is neither fast nor licensed for building our stored route corpus. |
| **openrouteservice public API** | Free Standard plan: 2,000 directions/day and 40/min; 500 matrix requests/day and 40/min; matrix limit 3,500 cells/request. | Directions quota: at least **203 / 321 days**. Matrix could fit the raw element count in one day, but only if useful OD pairs pack efficiently into Cartesian matrices. | Free | No explicit permanent-result grant located in the public plan/restriction pages; confirm before a bulk stored-data run. | Not appropriate through Directions. A carefully packed Matrix experiment may be useful, but the project directs larger workloads toward self-hosting or contacting it. |
| **Stadia Maps** | Standard routing is 20 credits/request; Standard plan has 7.5M credits and Professional 25M. Matrix is 10 credits/element, with 625/10,000 element limits. No public QPS commitment was found. | **Not estimable from published limits.** | Standard **$80/month** covers 375k routes, slightly short; Professional **$250/month** covers 1.25M. | **No under standard terms for this workflow.** Bulk downloading, server-side caching, derivative databases, and permanent storage are generally prohibited; benchmarking also requires permission. | Only with a negotiated enterprise agreement granting bulk generation, benchmarking, and permanent storage. |
| **Mapbox Directions** | 300 requests/minute; up to 25 waypoints/request. Matrix is 60 requests/minute and max 25 coordinates, billed per element. | **22.5 h / 35.6 h** | About **$610 / $1,026** using the current public monthly tiers and free 100k. | The public navigation pages do not give a clear permanent-storage grant. Mapbox content remains licensed content; obtain written confirmation for embedding a national offline route database. | Feasible capacity, but slower/costlier than open-data vendors and licensing is not clearly aligned with a distributable mod artifact. |
| **Google Routes Essentials** | Compute Routes: 3,000 requests/minute. Compute Route Matrix: 3,000 elements/minute, up to 625 elements/request. | **2.25 h / 3.56 h** | About **$1,670 / $2,473** at published Essentials tiers. | **No.** Google restricts caching and prohibits combining Routes content with a non-Google map. | Fast, but contractually unsuitable for permanently compiling results into this MapLibre/OpenStreetMap-derived mod. |
| **HERE Routing / Matrix** | Limited routing is 10 requests/s; Matrix is 1 request/s and can support very large asynchronous matrices. However, HERE explicitly says Routing access in Japan is restricted and requires contact. | The generic 10 requests/s floor would be **11.2 h / 17.8 h**, but it does **not** establish entitled Japan throughput. | Current public page requires contacting HERE for the relevant Japan use. | Results are available only for hours from the asynchronous matrix service; permanent downstream storage rights need a contract. | Potentially excellent matrix technology, but Japan access and licensing make this enterprise-sales-only. |
| **TomTom Routing / Batch** | Default Routing limit is 5 requests/s; Matrix is 10 requests/s. Asynchronous Batch Routing accepts 700 route items and retains downloadable jobs for 14 days. Custom-contract customers can raise QPS. | Direct routing: **22.5 h / 35.6 h**. Batch may reduce HTTP overhead, but no completion-rate guarantee is published. | Public page offers 20k Routing and 2.5k Matrix requests/month free; higher-volume cost is exposed through its interactive calculator or sales, not a stable static rate in the documentation. | Responses use `Cache-Control: no-cache`; the reviewed public terms do not grant permanent bulk route-database reuse. Obtain written rights. | Operationally attractive because of 700-item async batches, but pricing and stored-output rights need sales confirmation. |

Sources for the table:

- Geoapify [pricing](https://www.geoapify.com/pricing/),
  [Routing credit rules](https://apidocs.geoapify.com/docs/routing/), and
  [Route Matrix limits](https://apidocs.geoapify.com/docs/route-matrix/).
- LocationIQ [pricing and caching](https://locationiq.com/pricing),
  [Routing API](https://docs.locationiq.com/docs/routing-api), and
  [Matrix API](https://docs.locationiq.com/docs/matrix-api).
- MapMap [pricing](https://mapmap.ai/pricing),
  [quotas](https://mapmap.ai/docs/conventions),
  [worldwide hosted coverage](https://mapmap.ai/docs/territories), and
  [terms](https://mapmap.ai/terms).
- GraphHopper [plans and rate limits](https://www.graphhopper.com/pricing/),
  [credit rules](https://support.graphhopper.com/support/solutions/articles/44000718211-what-is-one-credit-),
  and [caching/bulk terms](https://www.graphhopper.com/terms/).
- openrouteservice [plans](https://openrouteservice.org/plans/) and
  [request restrictions](https://openrouteservice.org/restrictions/).
- Stadia Maps [pricing](https://stadiamaps.com/pricing/),
  [service limits](https://docs.stadiamaps.com/limits/), and
  [bulk/caching terms](https://stadiamaps.com/terms-of-service/).
- Mapbox [Directions limits](https://docs.mapbox.com/api/navigation/directions/),
  [Matrix limits](https://docs.mapbox.com/api/navigation/matrix/), and
  [pricing](https://www.mapbox.com/pricing).
- Google [Routes quotas](https://developers.google.com/maps/documentation/routes/usage-and-billing),
  [pricing](https://developers.google.com/maps/billing-and-pricing/pricing), and
  [Routes-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms/).
- HERE [Japan restriction and matrix scale](https://docs.here.com/routing/docs/matrix-v8-intro),
  [generic plan limits](https://www.here.com/get-started/pricing/rps-limits-excluded-use-cases),
  and [asynchronous matrix lifecycle](https://docs.here.com/routing/docs/matrix-v8-get-started).
- TomTom [default QPS](https://docs.tomtom.com/platform/documentation/api-best-practices/qps-limits),
  [Batch Routing](https://docs.tomtom.com/routing-api/documentation/tomtom-maps/batch-routing/batch-routing-service/),
  and [pricing/free allowances](https://docs.tomtom.com/pricing).

## Recommended procurement and pilot

1. Buy one month of **LocationIQ Growth Plus** only after confirming that its
   response-retention policy covers permanently embedding the resulting travel
   times and distances in redistributed mod artifacts. Implement one-origin,
   up-to-24-destination packing and checkpoint each returned OD cell.
2. Keep **Business Plus** as an escalation, not the default: $950/month at 40
   requests/second reduces the raw floor from 2.05 to 1.53 hours, only about 31
   minutes. Ask whether an in-place plan upgrade preserves the same token and
   cached request-response rights.
3. In parallel, ask Geoapify for a **one-month unmetered dedicated endpoint**
   with explicit redistribution permission, sustained Matrix throughput, Japan
   automobile-profile confirmation, and a data-freshness date. This is the
   cleanest fallback if LocationIQ's licensing confirmation is unsatisfactory.
4. Before paying, run the same 200-route benchmark through both candidates and
   compare against the public OSRM baseline. Vendor speed models can differ even
   when all products use OpenStreetMap geometry.
5. Query only unique endpoint/profile combinations, checkpoint every completed
   response, and use idempotent retries. For the measured matrix plan, budget
   **2.5-4 hours on LocationIQ Growth Plus** or **4-6 hours on Geoapify Custom**,
   plus validation and artifact integration. These ranges include more than 20%
   headroom because matrix response size and sustained throughput need a pilot.
6. If neither vendor will grant permanent redistribution on a short contract,
   use a hosted virtual machine running our own OSRM instance. Owning the routing
   service avoids response-licensing ambiguity and makes future prefecture/world
   rebuilds inexpensive after graph preparation.

The recommendation uses the measured origin-to-destination multiplicity, not a
dense all-to-all assumption. The packed Matrix calls return exactly the requested
one-origin rows (apart from splitting the maximum 48-destination origins), so
they avoid paying to calculate unrelated cross-origin cells.
