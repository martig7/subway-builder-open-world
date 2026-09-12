# Japan non-commute inter-prefecture demand from e-Stat and MLIT

Date: 2026-09-11. Revised after checking official survey documentation and the repository's demand compiler and runtime. Scope: feasibility evaluation and implementation recommendation; no source code, generated demand, or installed mod was changed.

## Evaluation

**A useful non-commute supplement is feasible, but the original proposal is not ready to implement as a complete national demand layer.** The source selection is broadly sound; its claims about coverage, counting units, easy integration, and full-prefecture extrapolation were too strong. The realistic outcome is a versioned, partly modeled travel-demand scenario with explicit coverage gaps. It is not a contemporary census of non-commute travelers.

The strongest national starting point remains the **2015 Sixth National Survey of Net Passenger Flow** (全国幹線旅客純流動調査). As of this review, MLIT's published OD index ends at 2015; the announcement of Eighth Survey fieldwork in 2025 is not a released replacement dataset. [MLIT downloadable tables](https://www.mlit.go.jp/sogoseisaku/soukou/sogoseisaku_soukou_fr_000018.html), [2025 survey announcement](https://www.mlit.go.jp/report/press/sogo23_hh_000184.html)

Five changes are necessary:

1. Use **actual origin-to-destination movement OD** as the national trip control. Residence-to-travel-destination tables are useful supporting evidence or a deliberately narrower home-based subset, but omit some trips and do not count unique round-trip travelers.
2. Keep **source persons, daily movement trips, runtime cohorts, and annualized money** distinct. The existing commute runtime cannot accept survey trip counts unchanged.
3. Retain 207-zone evidence where useful, but allow a prefecture-level pilot and pooling where justified. More spatial detail does not establish better statistical precision.
4. Treat metropolitan PT surveys as controls for their surveyed populations and days, with modeled return-purpose attribution and coverage extensions. Do not describe the result as fully observed national coverage.
5. Reject the FY2009 gross-transport-minus-Census calculation as a production calibration target. It cannot identify modern non-commute OD from the available quantities.

Reusing canonical cross-demand sites remains a good architectural choice. The work also requires a demand contract and runtime scheduling change, beyond adding a source adapter.

## Current repository baseline

The national consumer in source is manifest `local.japan-open-world`, built from [`prototype/japan/mod`](../../prototype/japan/mod/manifest.json). [`worlds/japan/demand.json`](../../worlds/japan/demand.json) declares `estat-japan` and `japan-estat-national-2020-2021`. This identifies the consumer relevant to this report; the running game was not inspected.

- The existing controls are 2020 Census residence-municipality to workplace/school-municipality counts of workers and students, not observed daily journey counts. The packager aggregates them to prefecture pairs and creates recurring home/work cohorts. See [`estat_japan_prefecture.py`](../../map-creator/src/open_world_map_creator/demand/estat_japan_prefecture.py) and [`package_japan.py`](../../map-creator/src/open_world_map_creator/demand/package_japan.py).
- Placement uses 250 m commuter/student residential weights and 500 m all-industry employment weights, projected onto building sites. A total-population origin surface and purpose-specific attraction surfaces are additional inputs, not capabilities already supplied by those two marginals.
- The recorded v7 run accepted 69,466,356 demand units and produced 33,553 cross-tile cohorts at 31,420 cross-tile sites. Its audit records `sourceLocalMass = 63,707,413`, so source inter-prefecture mass is **5,758,943**. Its **6,038,347 `crossMass`** is classified by final tile ownership, not statistical prefecture labels. These are different quantities. See the [v7 generation record](../japan-boundary-first-demand.md#completed-national-regeneration--2026-09-05) and the compiler's report construction.
- The prior claim of “all 2,082 possible non-self pairs” was incorrect: `47 × 46 = 2,162`. The v7 field `directedPairCount = 2,082` counts accepted source pairs **including self-pairs**. It is not proof of complete cross-prefecture connectivity.
- [`boundary_sites.py`](../../map-creator/src/open_world_map_creator/demand/boundary_sites.py) clusters buildings once per owner and assigns source weights to shared sites. [`building_sites.py`](../../map-creator/src/open_world_map_creator/demand/building_sites.py) derives site IDs from clustered building membership. [`owned_ledger.py`](../../map-creator/src/open_world_map_creator/demand/owned_ledger.py) classifies demand by final owners; the packager merges cross endpoints by site ID into `cross_points`.
- Cross-demand rows currently have home/work endpoints and `07:30`/`17:30` departure fields. The aggregate [`cross-tile-commute-engine.js`](../../open-world-platform/src/runtime/cross-tile-commute-engine.js) separately schedules departures at hours 7 and 17 and cycles mass between home and work. Changing the JSON times alone does not implement a non-commute scheduler.
- That engine already applies `NATIVE_FARE_MULTIPLIER = 365` to money. Ridership remains a count of dispatched people. The [cached-simulation ADR](../adr/0004-cached-simulation-owns-ticks-only-while-enabled.md) explicitly preserves this distinction.

Non-commute journeys can be additional travel by the **same people** represented in the Census layer. They add movement demand, not necessarily new residents. Separate provenance and a common movement accounting unit are required before combining totals or map labels.

## Source assessment

| Source | Useful contribution | Feasibility limit |
| --- | --- | --- |
| **2015 National Survey of Net Passenger Flow** | National trunk-travel OD, excluding commute/school; 50 statistical prefecture zones and 207 living areas, with weekday, holiday, annual, and mode products. [Table index](https://www.mlit.go.jp/sogoseisaku/soukou/sogoseisaku_soukou_fr_000018.html) | Old, restricted to the survey's trunk-travel scope, and excludes internal flows in the three metropolitan groupings. Actual movement OD and residence/visitor OD have different coverage. Use as a baseline scenario, not all contemporary cross-border shopping, leisure, and visiting travel. |
| **Regional Person Trip surveys: Tokyo 2018, Chukyo 2022, Kinki 2021** | Purpose-specific daily movement OD and finer regional geography; strongest candidates for the metropolitan omissions. [Tokyo tables](https://www.tokyo-pt.jp/data/H30), [Chukyo provider](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/offer/index.html), [Kinki provider](https://www.kkr.mlit.go.jp/plan/pt/data/index.html) | Resident samples, different years and geographic universes; aggregate return-home purpose does not identify the preceding activity. Public aggregate access does not imply access to linked person-day records. |
| **Travel and Tourism Consumption Trend Survey** | Recent domestic tourism/business trip totals, day/overnight mix, and prefecture marginals. [JTA results](https://www.mlit.go.jp/kankocho/tokei_hakusyo/shohidoko.html), [example e-Stat table dimensions](https://www.e-stat.go.jp/stat-search/database?kikan=00601&layout=dataset&page=1&statdisp_id=0003300795) | The cited prefecture table contains separate residence, main-destination, and destination marginals, not paired 47×47 OD. These do not identify prefecture pairs. Tourism journeys also have a different scope and counting unit from PT movement trips. |
| **Accommodation Survey** | Overnight destination patterns and, in selected detailed tables, guest-residence patterns. [JTA results](https://www.mlit.go.jp/kankocho/tokei_hakusyo/shukuhakutokei.html), [example detailed reference table](https://www.mlit.go.jp/kankocho/content/000192466.pdf) | Guest nights are not trips. Detailed residence matrices can cover a restricted establishment stratum; check each table. Prefecture totals cannot locate demand at individual hotels without separate capacity/location evidence. |
| **Common Standard Tourism Visitor Statistics** | Destination activity and day-trip checks where prefectures publish compatible data. [JTA overview](https://www.mlit.go.jp/kankocho/tokei_hakusyo/irikomikyaku.html) | Uneven coverage and visitor-entry definitions; no complete national paired OD control. |
| **Passenger Regional Flow Survey** | Historical or recent transported-passenger diagnostics by prefecture and transport category. [MLIT creation method](https://www.mlit.go.jp/k-toukei/kamoturyokakutiikiryuudoutyousa_toukeinosakuseihouhou.html) | Gross transport counts, no purpose separation, and different endpoint/transfer accounting. Private passenger cars were removed beginning FY2010. Even FY2009's broader coverage is not a net all-person non-commute matrix. [Scope change](https://www.mlit.go.jp/statistics/details/t-other-2_tk_000259.html) |
| **National Urban Transport Characteristics Survey** | Weekday/holiday behavior and rates by city type for modeling assumptions. [MLIT scope and limitations](https://www.mlit.go.jp/toshi/tosiko/toshi_tosiko_tk_000033.html) | Selected cities and small samples; MLIT distinguishes it from surveys capable of estimating metropolitan OD totals. |
| **2015 Metropolitan Transportation Census** | Rail/bus station and corridor checks. [Published tables](https://www.mlit.go.jp/sogoseisaku/transport/sosei_transport_tk_000035.html) | Mode-specific, old, and overlapping with commute demand. An all-purpose station OD is not additional non-commute demand. |
| **2021 Road Traffic Census automobile OD** | Purpose/day-type checks on vehicle movement. [MLIT results](https://www.mlit.go.jp/statistics/details/t-other-2_tk_000394.html) | Vehicle trips require occupancy conversion and purpose handling; they cannot be summed with all-mode person trips. Do not use a road series solely to force every OD cell positive. |

These sources mostly overlap real journeys. Use the additional datasets for compatible comparisons or explicit model calibration, not as independently additive layers.

## Counting and coverage decisions

### Actual movement OD is the safer primary control

The survey counts an actual origin-to-destination movement once across trunk-mode transfers. Representative modes partition those trips; used-mode categories can overlap. Use the published all-representative-mode total, or sum its mutually exclusive mode rows once. Do not sum used-mode counts into a supposedly mode-neutral person-trip total. [MLIT definitions](https://www.mlit.go.jp/statistics/details/t-ryokaku-2_tk_000008.html)

Residence-to-travel-destination OD remaps both outward and homeward movements onto the resident/visited-region association. It excludes touring movements where neither endpoint matches residence, and movements with unknown residence; the guide notes substantial missing residence information for cars. It also omits overseas-resident travel. Thus its total differs from actual movement OD, and it is not a count of unique visitors or completed tours. [Sixth Survey guide, printed pp. 33 and 36](https://www.mlit.go.jp/sogoseisaku/soukou/content/001340149.pdf)

For example, 100 people making A→B and B→A contribute 200 movement trips. Loading 200 as recurring round-trip cohort mass would request 400 departures when both directions run. Dividing arbitrary cells by two is not a general repair: direction imbalance, overnight stays, and multi-stop tours remain unresolved.

Recommended target: **daily directional non-commute movement trips within each source's documented population and geographic scope**. Keep residence association as optional supporting evidence. Actual domestic OD must not be labeled domestic-residents-only without a verified residence filter. A later [FF-Data](https://www.mlit.go.jp/sogoseisaku/soukou/sogoseisaku_soukou_fr_000022.html) visitor layer would require overlap accounting, not automatic addition.

### Choose one base-day convention

For the pilot, use a **representative weekday** for both trunk and metropolitan sources. Keep published annual trunk totals as a separate diagnostic. A later average-calendar-day scenario can use annual trips divided by the represented number of days, but mixing that with unadjusted PT weekdays creates an inconsistent temporal baseline. Annual net-flow purpose tables are not published; applying autumn purpose shares to annual totals is a model assumption. [MLIT temporal cautions](https://www.mlit.go.jp/statistics/details/t-ryokaku-2_tk_000008.html)

Record the workbook's unit before conversion: a value in thousands of annual trips needs both `× 1,000` and division by days; an expanded person-trips/day table needs neither population expansion nor `× 365`.

`base_weekday_trips × 365` may be reported as a **game-year equivalent**, if desired. It is not observed annual travel and must not be loaded as runtime daily mass. Money already receives the game's annualization factor. Keep any gameplay scaling separate and apply it exactly once.

The mixture of 2015 trunk travel, 2018 Tokyo PT, 2021 Kinki PT, 2022 Chukyo PT, and 2020/2021 placement inputs is a hybrid scenario. Pandemic-period behavior and later population or tourism changes cannot be removed by relabeling the data “2022” or “current.” Preserve source vintages; any update factors require an independently justified model and sensitivity results. Chukyo's final release specifically warns that pandemic effects remain. [Chukyo final overview, pp. 2–6](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/persontrip/pdf/no06_gaiyouban.pdf)

### 207 zones provide useful localization, not precise endpoints

Retain the original 207-zone keys in Demand Evidence. Municipal correspondence supplies geography, not observed building locations. The published correspondence includes one zone for all 23 Tokyo wards; other zones also cover large areas. Validate the correspondence against the chosen 2015 release and reconcile municipal mergers before joining to newer polygons. [Published zone correspondence](https://www.mlit.go.jp/seisakutokatsu/jyunryuudou/doc/207_Zone2005.pdf)

For the 47-prefecture World, explicitly map Hokkaido's four statistical prefecture zones to Hokkaido and classify resulting within-prefecture flows separately. Keep statistical geography distinct from final tile ownership. Do not infer source coverage from runtime cross-tile classification.

**The actual 2015 reliability workbooks cover all-mode, all-purpose actual movement OD.** Direct inspection found a single `全機関_全目的` sheet with actual origin/destination axes and a 95% relative-error definition. They do not provide matching errors for purpose-specific, residence-destination, annual, or individual representative-mode cells. Some fine-cell relative errors exceed 100%; assess their passenger-mass share before choosing pooling rules. [2015 207-zone weekday reliability](https://www.mlit.go.jp/common/001297385.xls), [2015 207-zone holiday reliability](https://www.mlit.go.jp/common/001297384.xls)

Use fine cells directly only when their evidence supports it. Pooling or shrinking sparse cells is reasonable, but changes the modeled allocation: conserve the chosen parent control and keep both raw and modeled values. Do not simultaneously promise exact conservation of every fine cell and a different shrunk fine-cell matrix. Unknown purpose must remain separately accounted for unless explicitly imputed. Sampling errors also do not measure the additional uncertainty from source age, placement, or extrapolation.

### Metropolitan gaps require more than joining three tables

Define the trunk survey's internal metropolitan omission set `M` as **30 directed prefecture pairs**: Tokyo/Kanagawa/Chiba/Saitama (`4 × 3`), Aichi/Gifu/Mie (`3 × 2`), and Osaka/Kyoto/Hyogo/Nara (`4 × 3`). These are excluded scope, not measured zero demand. [MLIT zone definition](https://www.mlit.go.jp/sogoseisaku/soukou/content/001340155.pdf)

Use PT controls only for the relevant part of `M` initially. Filter on **movement endpoints**, not just respondent residence. PT residents can travel beyond the survey boundary, while out-of-area residents' movements can be missing even when both endpoints are inside it. Outside `M`, trunk coverage still does not establish complete local cross-border travel coverage.

- **Tokyo:** use its 2018 weekday resident survey for the covered mainland area. Its surveyed population is age 5+; island and nonresident demand need separate treatment. [Survey design](https://www.tokyo-pt.jp/person/01), [municipality list and definitions](https://www.tokyo-pt.jp/data/01_01)
- **Chukyo:** the 2022 source covers residents of 54 Aichi, 33 Gifu, and 10 Mie municipalities. It cannot directly control all residents of Gifu and Mie. Master data require an application. [Provider methodology/access](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/offer/index.html) Use the corrected final release: it incorporates 2021 Road Census comparisons. Summing all representative modes removes a runtime mode-share constraint, but does not make the underlying estimate independent of mode-specific evidence. [Final methodology](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/persontrip/pdf/no06_gaiyouban.pdf)
- **Kinki:** the 2021 survey covers the four-prefecture omission group geographically within its larger two-fu/four-ken resident survey. That still does not mean all travelers were surveyed. [Survey design](https://www.kkr.mlit.go.jp/plan/pt/research_pt/index.html) The provider currently reports its custom aggregation system closed and directs users to downloadable results; a custom linked-record extraction is not an assured dependency. [Kinki data access](https://www.kkr.mlit.go.jp/plan/pt/data/index.html)

Map each survey's actual purpose codes into a common taxonomy; Tokyo's home-based categories are not a universal PT schema. Exclude commute/school movements. Retain business and private movements even when made by an employed person; excluding all employed respondents would remove valid non-commute trips. [Tokyo definitions](https://www.tokyo-pt.jp/data/01_01), [Chukyo definitions](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/term/index.html)

Return-home attribution is **not identifiable exactly from ordinary aggregate OD**. A reciprocal outbound purpose share can be a simple imputation for predominantly two-stop home-based travel, but misses work→shopping→home chains and tours returning through another zone. Prefer linked person-day evidence only if its access and fields are verified; define an activity-level rule for mixed-purpose tours. With aggregates, publish the directly classified non-commute trips, ambiguous return-home mass, and results under conservative/base/high allocation assumptions. Do not call those sensitivity ranges statistical confidence intervals.

Preserve PT external-zone legs as evidence from covered residents. Extrapolate only missing resident/activity strata, so already observed journeys to external destinations are not added again. Validate a population/attraction/distance model on held-out covered municipalities, including peripheral ones, before extending it. That test assesses transfer within the observed domain; it does not establish accuracy in unobserved mountain, island, or tourism areas. Neither the missing mass nor its importance is known just from the number of omitted municipalities.

### Reject the historical residual as a production fallback

The [FY2009 Passenger Regional Flow workbook](https://www.e-stat.go.jp/stat-search/file-download?statInfId=000027671736&fileKind=0) is a useful historical diagnostic because it predates the private-car exclusion. Broader transport coverage does not make it a non-commute person-trip control. The earlier six-cell numeric extraction was not independently revalidated here and should not be used as a production target.

The suggested residual and update method has four problems:

1. **Different units and endpoints.** Annual gross transport counts minus Census usual commuters/students is not non-commute travel. Even a fitted attendance/return factor does not recover transfers, trip chains, or true journey endpoints from transport-segment totals. [MLIT construction method](https://www.mlit.go.jp/k-toukei/kamoturyokakutiikiryuudoutyousa_toukeinosakuseihouhou.html)
2. **Unidentified residual.** Errors in the large all-purpose and modeled commute quantities become errors in their difference. Clipping a negative residual or discarding historic mode labels supplies no missing information.
3. **No valid temporal bridge.** Social Life Basic Survey participation in non-commute movement measures whether people undertook an activity, not its cross-prefecture destination or trip frequency. Population and participation trends cannot identify a 2009→2022 OD update. [Statistics Bureau result definitions](https://www.stat.go.jp/data/shakai/2021/kekka.htm)
4. **No justified error interval.** The disagreement between two biased estimates is a sensitivity spread, not a calibrated uncertainty interval. Withholding PT municipalities cannot validate historical full-prefecture cells that have no corresponding sub-prefecture observations.

Prefer a clearly labeled PT-based coverage model, with observed and modeled components retained separately, or leave the remainder unresolved. There is no defensible requirement to invent positive non-commute demand for every direction. Recompute zero/suppressed/missing counts from the selected release and OD type; counts from the older residence-table analysis do not automatically apply to actual movement OD.

## Integration and realism

### Endpoint placement

Use the existing shared site catalog, with purpose and endpoint-role weights. Total residential population is appropriate for a known residence endpoint; employment/commercial activity can support business locations; accommodation and attractions can support visitor destinations; residential evidence is useful for visits to homes. All-industry jobs are only a baseline attraction proxy, not validated tourism capacity.

For actual movement OD, neither endpoint is necessarily home. Return movements may start at a hotel or business and end at a residence. Apply residential weights only when the role is supported, otherwise use an explicit purpose/role mixture and retain that assumption. A population-only model is a useful comparison baseline; copying it everywhere or treating all job weights as visitor demand is not a realism claim.

The current sites are selected using commuter/job evidence. They may miss resorts, trailheads, or other destinations with little employment. Profile coverage before reusing them unchanged. Where new sites are needed, incorporate their evidence into the common owner-wide clustering pass. Because IDs depend on building membership, adding candidates can change existing IDs: use a versioned catalog or a tested stable-extension strategy and regenerate all dependent references coherently.

Keep source-zone labels through placement. Assigning a cell to a nearby building must not silently move its modeled demand into another statistical zone. Audit zone leakage, land constraints, and final ownership independently. Synthetic building precision should never be presented as observed endpoint accuracy. If both final endpoints share a tile, preserve the non-commute movement semantics; the current owner ledger's native home/work fallback is not a compatible conversion.

### A runtime contract is required

The existing [Demand Evidence schema](../../open-world-platform/contracts/demand-evidence.schema.json) admits home/work flows and home/job marginals, with no purpose, trip-unit, or schedule fields. The [cross-demand model](../../open-world-platform/src/runtime/cross-demand-model.js) and commute engine also assume home/work roles. Design a backward-compatible movement representation in `open-world-platform`, with Japan-specific evidence processing in `map-creator` and policies in `worlds/japan`.

The preferred behavior is a scheduled directional trip cohort with explicit origin, destination, daily mass, departure profile, and source class. It should generate only the journeys represented by that control. A same-day round-trip approximation is acceptable only as a separately labeled, validated subset with a documented trip-to-cohort conversion; it cannot represent the full trunk survey.

This reaches scheduling, routing, mode choice, cache invalidation, tile transitions, accounting, and displayed labels. Overnight/touring demand and long travel durations need an explicit policy. Preserve the [Native Save/finance boundary](../adr/0002-native-saves-own-rail-topology.md) and prevent duplicate revenue across normal and cached simulation.

All-mode evidence should not fix observed mode shares in the game. However, the current [cross-tile choices](../../open-world-platform/src/runtime/cross-tile-mode-choice.js) do not supply a general competing airline/ship network. Treating every long-distance or island trip as an ordinary road/subway choice can produce implausible results. Retain source mode for diagnostics, audit reachability and distance, and either provide a credible outside option or defer unsupported demand with its mass reported. Removing a mode quota does not remove the need for realistic alternatives.

### Preserve one cross-point collection with meaningful units

Publish commuter and non-commute cross movements through the canonical cross-site catalog. A site shared by classes should have one feature, owner, and coordinate, with separate class contributions and a combined demand view. Native point records can remain separate.

Do **not** simply add trip counts into `residents` and `workers` and describe the result as population or jobs. Convert each class into a common displayed daily movement measure, or retain separately labeled components. Keep the commuter person count available. Changing a display sum cannot substitute for adding the movements to the simulation.

Cohort growth is another practical constraint: `chunk_mass` currently defaults to at most 200 units per cohort. Splitting by zone, purpose, direction, and departure period can expand routing work and bundle size substantially. Choose a deterministic compression policy and measure its effect on both travel-time estimates and performance; do not prescribe a production cohort count before profiling the source.

## Recommended delivery plan

| Stage | Deliverable | Gate to the next stage |
| --- | --- | --- |
| **1. Evidence audit** | Pin actual-OD weekday, holiday, annual, residence-OD, and reliability files with hashes, units, zone crosswalks, and table identifiers. Profile one metropolitan PT source. | Reconcile totals and purpose unknowns; distinguish excluded, suppressed, zero, missing, and modeled cells. Compare actual and residence totals rather than assuming equality. Record exact download/use terms. |
| **2. Small gameplay pilot** | One well-supported trunk corridor and Tokyo↔Kanagawa weekday movement demand, using the shared sites and a versioned runtime trip contract. Prefecture controls are acceptable initially; retain finer source keys. | Prove direction/return accounting, timing, mode choice, revenue, and display units. Compare added daily departures with existing commute departures on the same basis. |
| **3. Covered national supplement** | Expand to validated trunk cells and PT-covered parts of the metropolitan groups; use 207-zone localization where supported. | Publish coverage and modeled shares, endpoint-placement audits, performance measurements, and vintage labels. No automatic full-pair or current-year claim. |
| **4. Optional coverage and temporal models** | Peripheral/nonresident estimates, improved purpose attractions, holiday profiles, and defensible updates. | Held-out checks and sensitivity analysis justify each extension; modeled mass remains distinguishable and reversible. |

Data access is part of stage 1. For example, Tokyo's detailed aggregate-data terms require attribution and prohibit passing on the raw aggregates unchanged; do not assume every provider's downloadable table or microdata has identical redistribution terms. Verify the intended derived-artifact use for each input before publication. [Tokyo detailed-data conditions](https://www.tokyo-pt.jp/data/agree01_01)

Publication checks should establish:

- Unit conversions occur once; expanded daily PT counts are not expanded again. Simulated directional departures match the chosen control, without automatic duplicate returns or a 365-fold demand inflation.
- Commute/school source controls remain intact. Non-commute classified trips, imputed returns, unknown purposes, extrapolated populations, and deferred mass reconcile separately.
- Conservation holds at the declared control level before and after deterministic rounding/compression. Any rejected or unplaceable mass has an explicit reason.
- Every endpoint resolves to one canonical site; mixed-class cross-site feature IDs are unique, and combined display values equal contributions in the same unit.
- Statistical zone, movement pair, and final tile-owner pair are auditable independently. All source overlaps are handled by an explicit selection rule.
- Revenue and journeys are counted once through save/load, tile changes, and normal/cached simulation; changing non-commute departure profiles changes actual dispatch times.
- Cohort counts, artifact size, routing/cache costs, and map responsiveness are measured against the recorded Japan baseline. An uncertainty band is labeled as sampling uncertainty only when the data/method support that interpretation.

For a later implementation, run the relevant compiler, platform, and Japan consumer tests; use the configured Runner for heavy generation; rebuild and install **`prototype/japan/mod`**, then verify its marker and runtime behavior as required by `AGENTS.md`. Those delivery steps were not performed for this documentation revision.

## Decision

Proceed with the evidence audit and a bounded weekday pilot. The public data can support a credible improvement over commute-only gameplay, including business and private travel. Full national coverage, accurate tourist endpoints, and contemporary trip totals remain modeling goals. The essential prerequisites are correct movement accounting and runtime support; 207-zone resolution and historical extrapolations should not obscure those requirements.
