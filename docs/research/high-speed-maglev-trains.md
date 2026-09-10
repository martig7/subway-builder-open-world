# High-speed rail and maglev train inputs

Researched 2026-09-09. This report supports two shared Open World train types:
an ICE 3neo-inspired high-speed train and a Transrapid-inspired high-speed
maglev. They are simplified game configurations, not certified reproductions.
The runtime source is authoritative for the final API field names and values.

## Evidence and representative vehicles

Deutsche Bahn reports that its eight-car ICE 3neo has 439 seats, a 201 m train
length, and a maximum speed of 320 km/h. Its May 2023 factsheet instead rounds
the length to 200 m and describes a doubled train. Use the current operator
page's 201 m consistently: 201 / 8 = 25.125 m per homogeneous game car;
439 / 8 rounds to 55 passengers per car (440 per eight-car train). This is
seated capacity, with no invented standing load. Real cars have different
lengths and seating layouts. [DB train page][db-train], [DB factsheet][db-sheet].

The 2020 DB/Siemens announcement prices 30 trains at approximately EUR 1 billion.
Allocate the contract evenly across 240 cars as a procurement estimate; it is
not a quoted standalone car price. [Original purchase announcement][db-order].

The Transrapid reference in the Federal Railroad Administration's 2005 report
uses approximately 82 ft-long, 12.2 ft-wide sections, roughly 100 coach seats,
and 3–10 sections per train. Its acceleration/deceleration figure is
3.3 ft/s². Rounded game inputs are 25 m, 3.7 m, 100 passengers, and 1 m/s².
The Baltimore proposal's USD 11.7 million per vehicle is in 2002 dollars;
“vehicle” means a car/section, not an entire train (Annex A, tables A-1–A-3).
These are historical planning estimates, not Shanghai procurement invoices.
[FRA report, printed pp. 2–3, A-9, A-13–A-16][fra].

For speed, China's railway regulator distinguishes the Shanghai line's
430 km/h maximum operating speed from its 501 km/h test speed. The foreign
ministry also documents a 430 km/h inaugural run. Use 430 km/h as historically
operated capability. Shanghai's current municipal guide, updated June 2026,
advertises 300 km/h service; this game entry does not reproduce that timetable.
[Railway regulator][nra], [inaugural operation][mfa], [current city guide][shanghai].

## Procurement currency basis

Use constant **2020 USD** for both game purchase prices, without claiming they
are 2026 market quotations. The Federal Reserve's annual 2020 exchange rate is
USD 1.1410 per EUR. BLS annual CPI-U is 179.9 in 2002 and 258.811 in 2020.
[Federal Reserve][fx], [BLS historical table, final page][cpi].

| Entry | Calculation | Rounded game cost per car |
| --- | --- | --- |
| High-speed rail | EUR 1,000,000,000 / 30 / 8 × 1.1410 | USD 4,750,000 |
| Maglev | USD 11,700,000 × 258.811 / 179.9 | USD 16,800,000 |

CPI normalization is a transparent purchasing-power approximation, not a
rolling-stock manufacturing index. Neither conversion models future orders,
tax differences, delivery conditions, financing, or production scale.

## Recommended game geometry and service inputs

**Assumption** means a deliberately chosen game parameter, not a measured
manufacturer specification. All platform lengths include game stopping margin;
they are not real-world station design requirements. Clearance is a construction
envelope, not the vehicle's height. Coupling gaps should not be counted twice
when deriving a homogeneous car length from overall train length.

| Input | High-speed rail | Maglev | Basis |
| --- | --- | --- | --- |
| Maximum speed | 320 km/h | 430 km/h | Evidence above; maglev historical capability |
| Car length | 25.125 m | 25 m | Derived / rounded above |
| Car width | 2.95 m | 3.7 m | HSR approximate game envelope; maglev rounded above |
| Capacity per car | 55 | 100 | Seated-capacity approximations above |
| Allowed formation | 8 or 16 cars | 3–10 cars | HSR single/double set; maglev section range above |
| Car-count increment | 8 | 1 | Game restriction matching formation model |
| Minimum platform | 210 m | 80 m | Assumption |
| Maximum platform | 420 m | 260 m | Assumption |
| Constant acceleration | 0.5 m/s² | 1 m/s² | HSR assumption; maglev rounded above |
| Service deceleration | 0.6 m/s² | 1 m/s² | HSR assumption; maglev rounded above |
| Lateral acceleration limit | 1 m/s² | 1 m/s² | Assumption |
| Maximum slope (`maxSlopePercentage`) | 4 (%) | 10 (%) | Assumption, not guaranteed at top speed |
| Minimum construction curve radius | 300 m | 350 m | Assumption for low-speed approaches |
| Minimum station curve radius | 2,000 m | 2,000 m | Assumption |
| Track center spacing | 4.5 m | 5.2 m | Assumption |
| Track edge spacing (1.435 m game gauge subtraction) | 3.065 m | 3.765 m | Derived from assumed centers |
| Outer track-edge clearance | 1.5 m | 1.8 m | Assumption |
| Dwell time | 90 seconds | 90 seconds | Assumption for intercity boarding |
| Maximum service frequency | 12 trains/hour | 12 trains/hour | Assumption, not line capacity certification |
| Maximum cant / cant deficiency | 180 mm / 150 mm | 180 mm / 150 mm | Assumed effective equivalents; maglev banking is abstracted |
| Speed past local station | 160 km/h | 160 km/h | Assumption |
| Crossover speed | 40 km/h | 40 km/h | Assumption |
| Yard speed | 4.47 m/s | 4.47 m/s | Assumption |
| Turnaround | 300 seconds | 180 seconds | Assumption |

Constant acceleration is a simplification: it omits power limits and drag.
At the chosen lateral acceleration, full speed requires approximately
7,901 m radius for HSR and 14,267 m for maglev using R = v²/a (no cant).
The construction minimum must therefore **not** imply full-speed cornering.
At constant acceleration/deceleration and without cruise, reaching top speed
and stopping takes approximately 14.5 km for HSR and 14.3 km for maglev.
Closely spaced urban stations should not deliver the headline speed benefit.

## Infrastructure and recurring cost assumptions

The World Bank's 2019 study reports Chinese high-speed network construction
costs of USD 17–21 million per route-kilometer, including routes with substantial
viaducts/tunnels. This is regional context, not an ICE-specific unit price or a
cut-and-cover quote. [World Bank, executive summary p. 3][world-bank].

FRA's Baltimore estimate separates guideway, propulsion/control and power:
USD 59.6 million per route-mile (2002), approximately USD 53.3 million per
route-km in 2020 dollars. Its USD 9.7 per car-mile O&M estimate includes
system costs; adding it to separate infrastructure upkeep would double-count.
[FRA tables A-3–A-4][fra].

The following are **gameplay assumptions** at the same 2020-dollar reference
scale. They are separate from the sourced vehicle procurement estimates.
The geography, construction method, service volume, and labor market prevent
a universal real-world dollar-per-hour or station price. Do not present these
values in source comments as supplier quotes.

| Cost input | High-speed rail | Maglev |
| --- | --- | --- |
| Base double-track cut-and-cover construction | USD 100,000/m | USD 150,000/m |
| At-grade multiplier | 0.20 | 0.30 |
| Trenched / ramp / elevated multiplier | 0.35 | 0.40 |
| Cut-and-cover multiplier | 1.00 | 1.00 |
| Other elevations | Native game defaults | Native game defaults |
| Base cut-and-cover station | USD 100 million | USD 150 million |
| Fixed operating cost per train-hour | USD 300 | USD 300 |
| Additional operating cost per car-hour | USD 125 | USD 500 |
| Track maintenance per physical track-meter/year | USD 50 | USD 75 |
| Station maintenance per year | USD 500,000 | USD 750,000 |

Thus at-grade track is USD 20 million/km and USD 45 million/km, respectively;
an eight-car HSR costs USD 1,300/hour to operate, and a three-car maglev costs
USD 1,800/hour. Two physical tracks give annual upkeep of USD 100,000 and
USD 150,000 per route-km respectively. There is no additive per-platform-meter
station-cost field. These splits give the game independent vehicle,
station, and infrastructure cost controls. A single assumed car-hour rate
does not claim to model speed-dependent energy consumption.

The maglev entry requires its own compatible guideway in reality: Transrapid
propulsion equipment resides in the guideway. [FRA, p. 2][fra]. If the game's
train API shares normal railway rendering or infrastructure, describe that as
a simulation limitation; adding a vehicle entry does not create a physical
magnetic-levitation engine.

## Sources

[db-train]: https://www.bahn.de/service/ueber-uns/zugtypen/ice-3neo
[db-sheet]: https://www1.deutschebahn.com/resource/blob/7032684/4a75e6c9d1095461ecd41202c9a2c792/Faktenblatt_Der-neue-ICE_mai23-data.pdf
[db-order]: https://assets.new.siemens.com/siemens/assets/api/uuid:cfaa1a08-e7b2-446d-b046-0cc18dc6994f/DB-invests-one-billion-euros-in-new-ICE.pdf
[fra]: https://railroads.dot.gov/sites/fra.dot.gov/files/fra_net/1176/maglev-sep05.pdf
[nra]: https://www.nra.gov.cn/xwzx/xwxx/xwlb/202204/t20220405_280276.shtml
[mfa]: https://www.mfa.gov.cn/eng/gjhdq_665435/3265_665445/3296_664550/3298_664554/202406/t20240611_11420954.html
[shanghai]: https://english.shanghai.gov.cn/en-Transportation/20240102/44f499a17b324b25996f2d58fcbf5f23.html
[fx]: https://www.federalreserve.gov/releases/g5a/20210104/
[cpi]: https://www.bls.gov/cpi/tables/supplemental-files/historical-cpi-u-202108.pdf
[world-bank]: https://documents1.worldbank.org/curated/en/933411559841476316/pdf/Chinas-High-Speed-Rail-Development.pdf
