# 7-tile pilot demand benchmark

PROTOTYPE — real 2023 NY LODES8 JT01 data; deterministic 100 m sites and 50–200 person cohorts.

- Input: **7,055,595** rows / **7,789,260** workers
- Build time: **586.1 s**
- SQLite work file: **1568.7 MiB**
- Cross-tile demand: **712,206 workers / 6,125 cohorts / 42 directed tile pairs**
- Driving times are geometric placeholders until the routing stage runs.

| Tile | Local OD rows | Workers | Sites | Cohorts | Cohort range | Gzip MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `NY_CP00_RP00` | 3,651,200 | 4,081,572 | 21,235 | 35,048 | 50–200 | 3.54 |
| `NY_CP00_RP01` | 140,364 | 158,447 | 1,864 | 1,370 | 50–200 | 0.17 |
| `NY_CP01_RP00` | 359,227 | 389,140 | 4,087 | 3,313 | 50–200 | 0.39 |
| `NY_CM01_RP01` | 26,382 | 30,159 | 338 | 248 | 50–200 | 0.03 |
| `NY_CM01_RP02` | 46,876 | 52,344 | 609 | 430 | 50–199 | 0.05 |
| `NY_CM01_RP03` | 2,357 | 2,607 | 34 | 22 | 53–183 | 0.00 |
| `NY_CP00_RP02` | 279,513 | 321,968 | 3,292 | 2,797 | 50–200 | 0.32 |
