# Japan non-commute movement magnitude and visitor supplement

Date: 2026-09-11. Unit throughout: **one-way person movements**, not unique
travellers. This note audits the existing
[`movements.csv`](../../worlds/japan/data/noncommute/movements.csv) and
[`build-report.json`](../../worlds/japan/data/noncommute/build-report.json);
it does not alter their counts.

## Scale check against domestic aviation

The ledger sums to **7,815,204 estimated movements on a representative
weekday**: 3,924,915 from the 2015 national 207-zone trunk survey and
3,890,289 estimated from the Tokyo, Chukyo, and Kinki resident Person Trip
surveys. The national survey measures true origin→destination journeys over
five trunk modes, excludes commuting/schooling, same-prefecture journeys, and
within-three-metropolitan-group journeys. Its weekday observations are an
autumn day, not an annual daily average. [MLIT survey definitions](https://www.mlit.go.jp/statistics/details/t-ryokaku-2_tk_000008.html),
[MLIT 2015 survey brochure](https://www.mlit.go.jp/sogoseisaku/soukou/content/001340149.pdf).

| Measure | Magnitude | Comparison meaning |
| --- | ---: | --- |
| 2015 domestic scheduled airline passengers, calendar-year total | 95.87 million boardings, or **262,658 per calendar day** | Carrier transport activity, all days; not a count of all OD journeys. [MLIT aviation statistics](https://www.mlit.go.jp/common/001276296.pdf). |
| 2015 national survey, `代_航空_全目的` | **261,801** published weekday air-representative OD movements in all numeric cells; **260,156** after this ledger's same-prefecture/metropolitan exclusions | About **99.0%** of the 2015 airline daily average after exclusions, but definitions and day bases differ. Extracted from the [official 207-zone workbook](https://www.mlit.go.jp/common/001297377.xls). |
| 2025 fiscal-year domestic scheduled airline passengers | 112.50 million boardings, or **308,219 per calendar day** | Current order-of-magnitude context; 2025 fiscal year and all-day average differ from the ledger's mixed survey years and weekday. [MLIT annual aviation summary](https://www.mlit.go.jp/report/press/joho05_hh_000909.html). |

The full 7.815 million ledger is roughly **29.8×** the 2015 airline daily
average or **25.4×** the 2025 fiscal-year daily average. That is unsurprising:
the ledger is all-mode and its metro component includes non-commute local trips;
aviation is only one mode. The close 2015 air-to-air match is a useful
**scale/internal-consistency check, not independent validation**: MLIT expands
the underlying mode surveys against carrier transport totals, while the
published net-flow journey and carrier boarding still differ in scope and
transfer accounting. [MLIT 2015 survey methodology](https://www.mlit.go.jp/sogoseisaku/soukou/content/001340149.pdf).
On the ledger's retained national pairs, the same 207-zone workbook attributes
2,747,055 weekday movements to car, 826,589 to rail, 260,156 to air, 79,231
to trunk bus, and 11,805 to ship (representative modes). Those mode sheets
sum to 3,924,836, only 79 below the separately published all-mode sheet;
the ledger uses the all-mode control. [MLIT 207-zone workbook](https://www.mlit.go.jp/common/001297377.xls).
As a separate broad check, MLIT reported approximately **1.8 billion**
2015-fiscal-year national trunk journeys across all modes, averaging roughly
4.9 million per calendar day; the ledger's 3.925 million national weekday
slice is of a plausible order, but the annual figure includes weekends and
is not a target total for this mixed-year ledger. [MLIT 2015 results](https://www.mlit.go.jp/report/press/sogo23_hh_000108.html).

## What is missing, and what “non-resident” means

The table is a coherent **partial weekday OD baseline**, not all daily travel
in Japan. Its national portion deliberately omits all same-prefecture journeys
and the 30 within-metro directed prefecture pairs; the latter are replaced by
the three PT sources, but not every within-prefecture trip is. The national
207-zone extract has 20,526 blank inter-prefecture cells, preserved as
`unreported_blank`; their missing mass cannot be inferred by treating blanks
as zero. The PT replacements also use different years, an inferred share of
return-home trips, and only surveyed resident populations/geographies.
The Tokyo PT samples residents of its metropolitan survey area (Tokyo,
Kanagawa, Saitama, Chiba, and southern Ibaraki); Chukyo samples residents of
Aichi, southern Gifu, and northern Mie; Kinki samples residents of its
six-prefecture region.
[Tokyo survey population](https://www.tokyo-pt.jp/person/01),
[Chukyo report](https://www.cbr.mlit.go.jp/kikaku/chukyo-pt/persontrip/pdf/no06_honpen.pdf),
[Kinki survey population](https://www.kkr.mlit.go.jp/plan/pt/research_pt/index.html).

“Non-resident” has two distinct meanings. A Japanese resident visiting a
*different metro area* is absent from that destination's resident-household PT
sample, even though a trunk leg into or out of the metro may already appear in
the national OD table. A visitor who does *not reside in Japan* is likewise
absent from those PT samples. The national trunk survey is based on passengers
using the modes rather than a metro household frame; its 2015 brochure compares
inbound foreign movements from FF-Data with a Japanese-plus-foreign total
labelled as the trunk survey. However, MLIT does not establish an exact
additive/exclusive partition between the two products in that comparison;
the underlying carrier expansion totals include foreigners. **Overlap with
national trunk rows is unresolved**, so an automatic all-pairs addition is
unsafe. [MLIT 2015 foreign-travel comparison](https://www.mlit.go.jp/sogoseisaku/soukou/content/001340149.pdf),
[MLIT survey-method discussion](https://www.mlit.go.jp/seisakutokatsu/jyunryuudou/report_ja/h17_report07.pdf).

## Best supplement: FF-Data, kept as a separate layer

MLIT's **FF-Data** is the strongest public OD source for visitors from outside
Japan. Its latest public release found here is **2024** and provides directed
prefecture-pair tables by nationality and by transport mode, separating
domestic-visit→domestic-visit legs from arrival-port→first-visit and
last-visit→departure-port legs. [MLIT FF-Data files](https://www.mlit.go.jp/sogoseisaku/soukou/sogoseisaku_soukou_fr_000023.html),
[MLIT data-format guide](https://www.mlit.go.jp/sogoseisaku/soukou/content/001992182.pdf).

I extracted the official [`2024_Nationality_OD.xlsx`](https://www.mlit.go.jp/sogoseisaku/soukou/content/2024_Nationality_OD.xlsx)
(SHA-256 `05b5b9b9bfb01b91c44a99be4991d8bfb00d364e397636b1c7e307655e1a0a2a`),
sheet `全国籍全機関`. B7 states **thousand persons/year**; origin codes are
C12:C62, destination codes F9:BD9, and the domestic-visit→domestic-visit
matrix is F12:BD62. Excluding unknown code 99 and within-prefecture flows
(including Hokkaido's subzones), it contains **48,590,762** directed
cross-prefecture visitor legs in 2024, or **132,762 per 2024 calendar day**.
These are annual counts, *not* observed weekday counts. MLIT's public release
also charts a broader **80.08 million** 2024 foreign-flow figure, but it should
not be mistaken for this domestic-visit-pair matrix; FF-Data also contains
port↔visit legs. [MLIT 2024 release](https://www.mlit.go.jp/report/press/content/001991126.pdf).

The **30 within-metro directed prefecture pairs** used by this ledger's PT
replacements contain **19,091,908 foreign-visitor legs/year** in that 2024
matrix, or **52,164 per calendar day** (366 days): Tokyo group 5,148,701
(14,067/day), Chukyo 750,370 (2,050/day), Kinki 13,192,837 (36,046/day).
This is only **0.67% of the present 7.815 million weekday ledger** as a
cross-denominator scale comparison. These pairs are excluded from the national
trunk table, while PT samples resident households; the visitor counts are
therefore kept in the separate
[`foreign-visitor-metro-2024.csv`](../../worlds/japan/data/noncommute/foreign-visitor-metro-2024.csv)
companion, not merged into the baseline. Its
[`build script`](../../worlds/japan/data/noncommute/build_foreign_visitor_companion.py)
checks the official source hash and units. The annual average is not a representative weekday;
such a conversion requires a separately justified season/day-type factor.
Exclude port links, unknown endpoints and subtotal cells. **Do not** add
all of FF-Data to the 2015 national rows. For a current-year national
scenario, compare aligned 2015 and 2024 visitor OD baselines first, estimate
only the *incremental* visitor component, and label that as a scenario rather
than an observed weekday fact. Even a simple 2015-to-2024 difference needs
method-change sensitivity: FF-Data added regional visitor-survey sampling in
2018, which MLIT cautions affects comparisons with earlier years.

FF-Data also has limits: it is an expanded sample, records *visits* (a person
can appear on multiple legs), can miss short/neighboring-prefecture travel,
does not robustly measure within-prefecture trips, and imputes mode shares to
some sample records. Its geography is prefectures rather than 207 zones, so
subdividing visitor legs to 207 zones would need an explicit spatial model.
[MLIT FF-Data guide, sections 1.1–2.1](https://www.mlit.go.jp/sogoseisaku/soukou/content/001992182.pdf).

For domestic residents visiting another region, the Japan Tourism Agency's
travel-consumption survey covers **Japan-resident** leisure and business trips
and reports 553.13 million domestic trips in 2025, but its trip/tour totals
are not directed daily movement legs; they are better for broad calibration
than for direct addition to this OD ledger. An [official e-Stat table](https://www.e-stat.go.jp/index.php/dbview?sid=0003300795)
does cross-tabulate domestic trips by resident prefecture and main/other
destination prefecture; it could constrain a *modeled* domestic-visitor
allocation, but it does not reconstruct each travelled leg. Accommodation
guest-nights are likewise a stock of nights, not movement legs.
[Japan Tourism Agency survey scope](https://www.mlit.go.jp/kankocho/tokei_hakusyo/shohidoko.html),
[2025 results](https://www.mlit.go.jp/kankocho/content/001981854.pdf).
