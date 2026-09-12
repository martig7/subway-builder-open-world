# A simple non-commute OD supplement for Japan

Date: 2026-09-11. Scope: source selection and a straightforward method for generating additional OD pairs.

## Recommendation

Build one table of **estimated non-commute movements per weekday between zones**, then distribute each count across the existing residential and worker density surfaces using deterministic weighted sampling.

Start with **prefecture pairs**, which the Japan demand pipeline already supports. The same method works with the national survey's **207 zones** when their geographic crosswalk is ready; that is a spatial refinement, not a different demand model. Prefecture resolution is sufficient for the first version.

The official count determines **how much travel connects two zones**. Density determines **where the synthetic endpoints fall inside them**. This gives a useful, reproducible baseline with few adjustable assumptions. It does not require attraction databases, a current-year forecasting model, or detailed travel schedules.

## Sources and count extraction

Use four public survey extracts: one national source and three regional sources for the national survey's metropolitan omissions.

| Coverage | Source to download | What to take |
| --- | --- | --- |
| National trunk travel | **2015 National Survey of Net Passenger Flow**, weekday actual origin→destination: [50-zone XLS](https://www.mlit.go.jp/common/001297361.xls), labeled `2015DW_050OD_DK.xls`. The [207-zone XLS](https://www.mlit.go.jp/common/001297377.xls), labeled `2015DW_207OD_DK.xls`, is the finer alternative. | Sheet `代_全機関_全目的`: all representative modes, all purposes, **persons/day**. Use this sheet once. |
| Tokyo metropolitan group | **2018 Tokyo Person Trip survey**, [purpose × representative-mode CSV](https://www.e-stat.go.jp/stat-search/file-download?statInfId=000032066127&fileKind=1). | Expanded weekday movements, grouped to prefecture pairs; apply the non-commute filter below. Decode the CSV as CP932. |
| Chukyo metropolitan group | **2022 Chukyo Person Trip survey, final results**, [purpose × representative-mode XLSX](https://www.e-stat.go.jp/stat-search/file-download?statInfId=000040268715&fileKind=0). This is the final release published in March 2025. | Same extraction and filter. Select COVID-effect category `計` once. |
| Kinki metropolitan group | **2021 Kinki Person Trip survey, final results**, [purpose × representative-mode XLSX](https://www.e-stat.go.jp/stat-search/file-download?statInfId=000040170629&fileKind=0). | Same extraction and filter. Exclude aggregate endpoint rows such as `合計`/`00000`. |

The [MLIT national download index](https://www.mlit.go.jp/sogoseisaku/soukou/sogoseisaku_soukou_fr_000018.html) identifies both national files. The 2015 survey is the latest complete national release found in this review.

### National counts: use the published total directly

The trunk survey already excludes commuting and schooling. Its all-purpose total therefore provides the desired non-commute count without subtracting Census commuters or estimating a tourism share. Use actual origin→destination OD because it preserves movement direction. Representative-mode totals count a journey once across transfers. [MLIT definitions](https://www.mlit.go.jp/statistics/details/t-ryokaku-2_tk_000008.html)

For the prefecture version, merge Hokkaido's four statistical zones into prefecture 01, sum duplicate directed pairs, and retain different-prefecture pairs. For the 207-zone version, retain published zone pairs between different prefectures and attach their municipality-based geography using the [zone correspondence](https://www.mlit.go.jp/seisakutokatsu/jyunryuudou/doc/207_Zone2005.pdf), reconciling historical municipality codes as needed.

Accept the published estimates as the baseline. Sparse cells and old vintages are limitations we can tolerate; statistical smoothing is not required for this version. Preserve reported zeros and distinguish them from missing or excluded cells.

### Metropolitan counts: one simple non-commute filter

The national survey omits travel within these groups:

- Tokyo, Kanagawa, Saitama, Chiba: 12 directed pairs.
- Aichi, Gifu, Mie: 6 directed pairs.
- Osaka, Kyoto, Hyogo, Nara: 12 directed pairs.

Use the corresponding PT source for these **30 pairs only**. Keep the national source for other pairs, preventing overlap. [MLIT exclusion groups](https://www.mlit.go.jp/sogoseisaku/soukou/content/001340155.pdf)

Select each PT file's all-representative-mode total once, keeping individual purpose rows and detailed OD rows rather than their subtotals. Aggregate these zones to prefectures. Map the file's actual purpose labels into three categories:

- `B`: business, shopping, leisure, visiting, and other explicitly non-commute movements.
- `C`: commute and school movements.
- `R`: return-home movements whose earlier purpose is unspecified.

Use **one regional fraction** to estimate the non-commute share of returns. Compute it from the same extract restricted to that region's target cross-prefecture pairs:

```text
q = sum(B) / (sum(B) + sum(C))
noncommute(i, j) = B(i, j) + q × R(i, j)
```

This proportional allocation is our approximation, not an official return-purpose estimate. It avoids both dropping every non-commute return and including every commuting return. For example, if `q = 0.4`, a pair with 1,000 non-commute movements and 600 unspecified returns receives an estimate of 1,240 movements. Exclude wholly unknown purpose from the calculation and report that omitted mass. If the denominator is zero, leave the estimate unresolved.

Regional purpose labels differ; use the [Tokyo definitions](https://www.tokyo-pt.jp/data/01_01), [Chukyo glossary](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/term/index.html), and Kinki workbook definitions. No person-level records or tour reconstruction are needed.

Use published regional counts without geographic extrapolation in version one. Tokyo excludes island residents; Chukyo covers only parts of Gifu and Mie; the PT surveys represent their covered resident populations. Mark those counts as partial coverage and accept the resulting shortfall. The [Chukyo provider](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/offer/index.html) explicitly describes its resident coverage. These are survey-year baseline estimates, not complete current-year totals.

## Distribute counts using existing density

For each directed zone pair with count `F`:

1. Select existing canonical sites in the origin and destination zones.
2. Weight origin sites by the existing residential/commuter surface and destination sites by the existing worker/job surface. Normalize weights within each zone.
3. Round the final pair count once, retaining the original estimate for reference. Split it into groups of at most 200 movements, following the current cohort-size convention.
4. For each group, independently sample one origin and one destination using a stable seed derived from the source, zone pair, group number, and endpoint role.
5. Store the group's count and endpoint site IDs. Reuse the shared cross-point catalog so the same site does not acquire a duplicate dot for this demand class.

Equivalently, an origin site with 10% of its zone's residential weight has a 10% selection probability; a destination site with 5% of its zone's worker weight has a 5% probability. Repeating the build with unchanged inputs produces the same pairs. Group counts sum exactly to the rounded zone-pair control; site-level totals approximate the density weights through sampling.

The current 250 m origin surface describes workers/students, rather than all residents, and jobs are a generic attraction proxy. **Use them anyway for the first version.** The goal is plausible spatial distribution from available inputs. Apply the same rule to every directional row, including returns; it does not reconstruct anyone's actual home or trip chain. A total-population surface or purpose-specific weights can be substituted later without changing the OD totals.

Keep sites within their selected zones and use existing land/building placement rules. If a zone has eligible sites but zero weight, sample those sites uniformly and record the fallback. If it has no eligible sites, report the unplaced mass. Do not silently move endpoints to another zone.

The reusable implementation is already in [`package_japan.py`](../../map-creator/src/open_world_map_creator/demand/package_japan.py): `WeightedPicker`, `chunk_mass`, and the cross-point accumulator. [`boundary_sites.py`](../../map-creator/src/open_world_map_creator/demand/boundary_sites.py) supplies the shared building sites. Japan's [demand definition](../../worlds/japan/demand.json) identifies the existing density inputs.

## Deliverable and minimal checks

Produce a small source ledger with `origin_zone`, `destination_zone`, `estimated_movements_per_weekday`, `source`, `year`, and `coverage`; then a sampled-pair file with endpoint site IDs and movement counts. Keep original downloads, hashes, and the three regional `q` values alongside it. The non-commute ledger stays identifiable alongside the existing commute data.

Four checks are sufficient for this stage:

1. Source totals reconcile with extracted totals and explicitly omitted rows.
2. Each directed pair uses one source and its sampled groups conserve the rounded count.
3. Every endpoint resolves to an eligible canonical site, with repeatable sampling.
4. Counts mean **one-way daily movements**: do not automatically add another return, multiply daily demand by 365, or label it additional unique residents. Runtime wiring must preserve that unit; detailed departure schedules can wait.

This report specifies the OD estimate and placement artifact. It does not make a new scheduler, tourism model, hotel dataset, seasonal adjustment, historical residual calculation, or full geographic extrapolation a prerequisite. The first implementation is simply **official non-commute counts, a transparent metro return estimate, and density-weighted endpoint sampling**.
