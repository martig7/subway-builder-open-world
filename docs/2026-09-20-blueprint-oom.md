# Renderer OOM while drawing blueprints

At **2026-09-20 01:02:26.986 EDT** (05:02:26.986 UTC), Chromium reported `V8 javascript OOM (MarkCompactCollector: young object promotion failed)` for renderer PID 41784. Subway Builder logged the renderer crash 32 milliseconds later, exit code -36861, and automatically restarted it. The user was drawing blueprints in Tokyo mainland. This is a confirmed native V8 allocation/garbage-collection failure, not a caught routing exception.

This investigation is post-crash forensics. It replays preserved recorder evidence; it does not reproduce the allocation in the running game or establish a fixed regression. No runtime change was made, no game action was replayed, and no heap dump or forced collection was requested.

## Last measurements before failure

The final available heap sample was at **01:02:24.923**, about 2.1 seconds before the fatal error:

| Measurement | Observed value |
| --- | ---: |
| Main renderer JavaScript heap used | 2.845 GiB |
| Main renderer JavaScript heap allocated | 3.012 GiB |
| All worker JavaScript heaps allocated | 0.920 GiB |
| Main plus workers allocated | 3.932 GiB |
| Main renderer backing storage, reported separately | 0.979 GiB |
| Native road-tile worker heap used | 711 MiB |
| Renderer process private bytes, 0.276 seconds before fatal error | 6.107 GiB |

These measurements have different scopes. Backing storage and process private bytes must not be blindly added to the heap totals. The combined allocation total is an observation, not proof of a particular shared heap ceiling. The final allocation and peak may fall between samples. No native stack identifies the failed allocation's JavaScript caller.

## Sequence

- At 00:50, the main renderer used about 1,267 MiB and worker heaps used 597 MiB in Chiba.
- The recorder context changed to Tokyo mainland at 00:53:48.
- At 00:54:36, the main heap used 2,028 MiB; at 00:58:02 it used 2,734 MiB. Memory was accumulating for several minutes before the crash.
- A demand preparation request was refused at 00:55:38 with `NativeDemandMemoryPressureError`.
- The last recorded demand-worker job ran from 00:56:21.868 to 00:56:45.677. It processed 59,201 Tokyo cohorts and wrote 44,926,231 bytes of compressed disk cache. It finished **341.309 seconds before the OOM**.
- No `open-world-native-demand-worker-evaluator-v4-bounded` worker was present in the final worker inventory. Besides the road-tile worker, the largest remaining worker used about 120 MiB; another used 23 MiB.
- The autosave generated at 01:00:55 completed at 01:01:22.690, with a 221,616,737-byte upload.
- `LOAD_AND_SET` at 01:01:30 staged that save for recovery. The periodic checkpoint in `native-saved-reload-guard.js` invokes `loadAndSetPendingSave`; it does not reload the renderer. The game log contains no renderer-loading/game-loaded event between the Tokyo load and the crash.
- The last activity was map movement around Tokyo while the user was drawing blueprints. The final sample still called main-heap pressure "normal" because its main-isolate used-heap metric was about 70% of the reported limit, despite substantial worker and backing storage.
- Automatic recovery reopened the completed Tokyo autosave. Read-only inspection found 1,312 stations, 252 route records, and a paused game. The installed worker/kernel markers and cached-simulation generation 16 were present. This cannot recover edits made after the autosave was generated.

## Attribution and limits

The immediate failure occurred in an already memory-heavy renderer during blueprint work. The trace excludes an actively running new native-demand routing worker at the moment of failure. It does **not** exclude retention of results previously published to the renderer, a map/editor cache, native city data surviving a tile transition, or another main-thread owner. A quiet worker and a successful isolated routing benchmark do not establish whole-game memory safety.

The next investigation should distinguish (1) blueprint/map geometry accumulating during editing, (2) data retained across Chiba-to-Tokyo transition, and (3) retained demand results after publication. Allocation sampling and ownership probes across a short editing sequence are needed before selecting a fix. The recorder has no blueprint-specific counters or retaining paths, so naming a particular cache as the cause would overstate the evidence.

Private evidence is preserved under Git-ignored `.analysis/post-routing-oom/`: a snapshot of the renderer recorder, native Chromium output, game log, narrowed crash window, scalar summary, and recovered-state inspection. `node .analysis/summarize-oom-trace.mjs` deterministically confirms the captured OOM signature and prints the preceding heap/worker timeline. Its output is forensic evidence, not a reproduction test for an eventual fix.
