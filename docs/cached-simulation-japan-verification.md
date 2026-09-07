# Ultra-high-speed cached simulation

Open **Map rendering → Ultra-high-speed mode**. Initial calculation pauses time
advancement until assignments are ready. It uses the live loaded demand and
complete native network, then reuses the result until relevant inputs change.
Native demand cards retain mode splits, named route legs, fares, station
coordinates, departure/arrival times and income-chart inputs. Both commute
directions are calculated. The mode is off on a new load or mod reload.

This substitutes estimated ridership and finances for dynamic simulation.
Trains, signals, crowds and individual passengers stop advancing. The native
clock, ledger, bond processing and existing inactive/cross-tile settlement
continue. Ultra speed has an explicit 10× clock multiplier. The simulation
does not model capacity, train delays or reliability. Infrastructure costs are
estimates, with native train-type prices and grade-crossing maintenance.

## Live verification

Tested in `local.japan-open-world`, built from `prototype/japan/mod`, with
**Japan Regional 316 - Tokyo to Kobe** at `JP_PREF_27`: 316 stations, 53 routes,
2,294 tracks and 28,709 loaded native pop groups.

All loaded pops received both directional assignments with conserved mass;
3,979 directional groups had transit choices and valid path coordinates.
The actual native Pop Details panel displayed a 200-person group as 29 transit
and 171 driving, with named routes and a $2.50 fare. Contiguous legs on one route
are combined, so station dwell does not appear as a new transfer.

The frozen-state comparison covered complete trains, signals and track
occupations. No native passenger movements were present. Returning to native
mode moved trains normally for a further 328 simulated seconds with no captured
errors and unchanged topology counts. Native synchronous save generation and
automatic saves succeeded. A live run crossed midnight; hourly settlement and
the day callback continued. Pause remained set after the final timed runs.

Raw timing and install evidence are in `cached-simulation-japan-benchmark.json`.
The approximately six-second timed windows advanced 1,128 native seconds versus
18,240 cached seconds: 16.23× game-time throughput. Median update duration was
55.3 ms versus 22.5 ms; initial assignment compilation took 2.223 seconds.
Throughput includes the intentional 10× Ultra-speed clock multiplier and must
not be interpreted as an equivalent-output CPU benchmark. Calculated outcomes
are estimates and are not asserted equal to native dynamic simulation.
The timed run preceded the final grade-crossing expense addition. That final
bundle was separately rebuilt, installed, reloaded and exercised through
assignment calculation and synchronous native save generation.

## Validation and scope

The platform suite covers bypass/restoration of native actions, current versus
late worker responses, both-direction demand views, partial-hour and midnight
finance integration, synchronous save generation, train timing rebasing,
failure/pause behavior, prior-generation replacement and the toolbar toggle.
The Japan consumer's behavioral suite also passes.
Final totals: 599 platform tests and four Japan tests, all passing.

The original regional `.metro` file was not overwritten. Its SHA-256 remains
`846b18707c4aa3f82a3f5b060f8637cef733b57dd12c187b41cdab18fb5415df`.
Testing advances the in-memory game and its normal autosaves. The delivered
game is paused with the cached-mode toggle off, matching the user's state
before final installation. A native reload recovery preserved the clock,
network and World identity; its temporary display name was restored to the
regional save's name without overwriting the original file.

During development, live autosave caught an asynchronous-wrapper mismatch;
the delivered wrapper preserves the native synchronous return type and a
regression test covers it. One existing test that asserts a measured operation
takes exactly zero milliseconds was timing-sensitive on one run; it passed
alone and in the subsequent complete suite.
