# Free completion of the Gifu–Mie–Aichi prefecture flows

Date: 2026-09-11. Scope: free/public official sources for completing the six directed Gifu–Mie–Aichi noncommute flows outside the resident coverage of the 2022 Chukyo Person Trip (PT) survey. Purchased data and sources restricted to one transport mode are out of scope.

## Conclusion

No current free official source supplies all six cells as observed, all-mode, typical-weekday noncommute trips. They can nevertheless be completed without buying data as explicitly modeled values.

The strongest free full-prefecture anchor is MLIT's **2009 Passenger Regional Flow Survey** (`旅客地域流動調査`), the last release before private passenger cars were removed. Its `全機関` table contains all six directions and combines JR, private rail, buses, taxis, private passenger cars, ships, and air. Use only the total, not its mode shares. [Official 2009 workbook](https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000027671736), [MLIT survey description](https://www.mlit.go.jp/statistics/details/t-other-2_tk_000211.html)

The recommended free solution is to preserve all 2022 PT observations, synthesize only trips produced by residents outside the PT sample, and constrain that uplift against the 2007–2009 regional-flow totals after removing commute/school and modernizing the residual. The output must be labelled **modeled typical-weekday noncommute trips**, not observed 2022 prefecture OD.

## Verified free full-prefecture anchor

The verified 2009 `全機関` cells are:

| Direction | Annual flow (thousand persons) | Annual total / 365 (persons/day) |
| --- | ---: | ---: |
| Aichi → Gifu | 115,274.812 | 315,821 |
| Gifu → Aichi | 114,832.563 | 314,610 |
| Aichi → Mie | 61,067.804 | 167,309 |
| Mie → Aichi | 60,602.808 | 166,035 |
| Gifu → Mie | 5,306.965 | 14,540 |
| Mie → Gifu | 5,332.505 | 14,610 |

The last column is only a calendar-day average, not a typical weekday estimate. The values come directly from the official workbook linked above.

These figures cannot be added directly to the PT data because:

- they are annual gross passenger movements assembled from transport statistics, not unique diary trips classified by purpose;
- they combine commute, school, business, private, and return travel and predate the PT survey by 13 years;
- where direction was unavailable, the survey could split a two-way total equally between directions; and
- MLIT warns that the automobile source was designed for national totals and fine regional estimates can have very low precision. It recommends larger aggregation or multi-year averaging. Use the 2007–2009 mean where possible, with 2009 as the reproducible last-year check. [Official methodology](https://www.mlit.go.jp/statistics/details/t-other-2_tk_000211.html), [official data-quality note](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-S05-d-2018.html)

From fiscal 2010 onward this series excludes private passenger cars, so later tables are not a full-mode replacement. They can validate trends in the modes that remain. [MLIT exclusion note](https://www.mlit.go.jp/statistics/details/t-other-2_tk_000259.html)

## What the 2022 Chukyo PT survey already observes

The PT survey sampled residents of 97 municipalities: all Aichi, 17 cities and 16 towns in southern Gifu, and 5 cities and 5 towns in northern Mie. Its expansion represents those residents, not all residents of Gifu and Mie. [Official report, pp. 2–3](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/persontrip/pdf/no06_honpen.pdf), [coverage summary](https://ptplatform.mlit.go.jp/uploads/action/chukyo_toshiken_pt.pdf)

The purpose OD workbook nevertheless records sampled residents' legs to or from uncovered geography. Keep `岐阜県_圏域外` and `三重県_圏域外`: they are observed all-mode pieces of the missing flows. They do not contain trips produced by unsampled residents of northern Gifu or central/southern Mie, or trips wholly between unsampled residents. The zone-workbook codes `29999`=`岐阜県` and `39999`=`三重県` are whole-prefecture aggregates, not the out-of-area remainder. [Purpose OD workbook](https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000040268809), [zone-code workbook](https://www.e-stat.go.jp/stat-search/file-download?fileKind=0&statInfId=000040269413)

Custom aggregation or restricted PT records cannot create the missing residents; finer access changes geography, not the sampled population.

## Concrete free estimator

For each ordered pair `i → j`:

1. **Observed base.** Let `Oij` be 2022 PT weekday noncommute trips, including qualifying return-home legs and the Gifu/Mie out-of-area endpoints. Do not expand these rows again.
2. **Missing productions.** For each uncovered municipality, multiply resident population by purpose-specific weekday trip rates from matched covered PT municipalities. Match on density, age structure, urban/rural class, and access to a major centre.
3. **Gravity allocation.** Allocate those productions with a doubly constrained model fitted only on observed PT flows: `X(u,d,p) ∝ P(u,p) × A(d,p) × exp(-βp × travel_time(u,d))`. Fit purpose-specific attractions and distance decay. Pair outward and return-home legs at the tour level. `Xij` must contain only synthetic legs from uncovered residents, preventing double counting of PT external-zone rows.
4. **Historical noncommute constraint.** Let `Bij` be the 2007–2009 mean annual `全機関` flow. Remove an annual commute/school estimate based on the 2010 Census exact residence-to-work/school matrix. A physical weekday direction contains outbound trips by residents of `i` working/studying in `j` and return legs by residents of `j` working/studying in `i`; the term is therefore proportional to `C10ij + C10ji`, not only `C10ij`. Fit attendance-days and gross-passenger-to-PT-trip conversion on PT-covered comparisons rather than equating one Census person to one daily trip. [2010 Census tables](https://www.e-stat.go.jp/en/stat-search/files?cycle=0&layout=datalist&page=1&tclass1=000001049567&tclass2=000001051128&tclass3val=0&toukei=00200521&tstat=000001039448)
5. **Weekday conversion.** Use the Social Life Basic Survey's prefecture-specific weekday/Saturday/Sunday pattern for `移動（通勤・通学を除く）` to convert the annual residual to a weekday. This measures activity/time, not trips, so use it only as a day-type multiplier and sensitivity input. [2021 table](https://www.e-stat.go.jp/index.php/stat-search/database?cycle=0&layout=datalist&month=0&page=1&statdisp_id=0003457695&tclass1=000001158164&tclass2=000001158180&tclass3=000001158184&tclass4val=0&toukei=00200533&tstat=000001158160&year=20210)
6. **Modernization scenarios.** Produce three 2022 constraints: population change only; population plus the change in `Cij + Cji` from the 2010/2020 Census as a pair-connectivity index; and those factors plus comparable Social Life noncommute activity change. These are modernizers, not substitute trip observations. [2020 Census prefecture OD](https://www.e-stat.go.jp/dbview?sid=0003454526)
7. **Reconcile only the uplift.** For each unordered prefecture pair, scale the two directional `X` components together so `O + X` approaches each scenario constraint. Preserve the gravity model's contemporary directional split; use the historical split only as a weak regularizer because some directions were imputed. Use the median scenario as the central control.

The uncertainty interval should include PT bootstrap error, separate 2007/2008/2009 anchors, alternative commute attendance and gross-to-trip fits, and the full spread of the three modernization scenarios. Use `Oij` as a hard lower bound. Expect the widest relative interval for Gifu↔Mie because its historic total is small and the old automobile estimate is least reliable at fine geography. Store `observed_pt`, `synthetic_uncovered_residents`, `historical_constraint`, `scenario`, and `uncertainty` separately.

## Why the other free official datasets do not complete the cells

| Source | Exact six pairs? | Measure and proper role |
| --- | --- | --- |
| 2007–2009 Passenger Regional Flow | **Yes** | Annual gross multi-mode passenger flow, including private cars through 2009. Full-prefecture magnitude constraint, not a direct weekday trip table. |
| 2022 Chukyo PT | Partial | All-mode weekday trips with purpose. Observed base and gravity/trip-rate model. |
| 2010/2020 Population Census | **Yes** | Persons by usual residence and workplace/school. Commute-school subtraction/connectivity only, not trip counts. |
| MLIT nationwide open human-flow | No | Mobile-derived staying population, not trips; origin is only same municipality, same prefecture, same broad region, or elsewhere. All three prefectures are in the same broad region. [Release](https://www.mlit.go.jp/tochi_fudousan_kensetsugyo/tochi_fudousan_kensetsugyo_fr17_000001_00006.html), [specification](https://www.mlit.go.jp/tochi_fudousan_kensetsugyo/chirikukannjoho/content/001733098.pdf) |
| JTA Travel and Tourism public tables | No | Public OD is 10 regions × 10 regions; the 47-prefecture table is a destination marginal. All three origins collapse into Chubu. Travel episodes also miss many ordinary short border trips. [Survey](https://www.mlit.go.jp/kankocho/tokei_hakusyo/shohidoko.html), [public workbook](https://www.mlit.go.jp/kankocho/content/001998225.xlsx) |
| Project LINKS tourism open data | No | Annual prefecture traveler/spending marginals, not origin × destination. [Official inventory](https://www.mlit.go.jp/links/use-cases/1903.html) |
| RESAS | Not in a current general-trip product | Staying/passing population or travel-like card users with coarse origins or selection bias. Directional tourism validation at most. [Staying-population interface](https://resas.go.jp/town-planning-staying-mesh), [legacy-data notice](https://www.chisou.go.jp/sousei/resas/pdf/20250306_resas-legacy-data.pdf) |
| Social Life Basic Survey | No | Resident activity/time by prefecture and day type; no destination. Day-type/activity multiplier only. |
| National Urban Transport Characteristics Survey | No | All-mode diaries in selected cities. MLIT says roughly 500 households per city cannot estimate OD totals. [MLIT limitation](https://www.mlit.go.jp/toshi/tosiko/toshi_tosiko_tk_000033.html) |
| National Interregional Passenger Net Flow Survey | **No for these pairs** | It is all-mode and excludes commute/school, but defines Gifu, Aichi, and Mie as one Chukyo region and excludes travel within it. [Survey](https://www.mlit.go.jp/sogoseisaku/soukou/sogoseisaku_soukou_fr_000016.html), [scope, pp. 34–35](https://www1.mlit.go.jp/sogoseisaku/soukou/content/001340149.pdf) |

Restricted JTA microdata can identify residence and destination prefectures, but requires an application and covers qualifying travel episodes rather than ordinary short border trips. It does not meet the present no-contact, ordinary-weekday requirement. The 2021 Road Census is car-only, so it remains a validation source rather than the completion control.

## Recommendation

Implement the PT-plus-gravity estimator, using the 2007–2009 `全機関` mean as a soft full-pair constraint and the verified 2009 cells as the last-year check. This is the best-supported free workaround: the historical constraint covers every mode, contemporary PT supplies purposes and weekday behavior, only unsampled residents are added, and no historical mode share is imposed on the simulation.
