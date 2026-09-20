# Evaluation-scoped preparation experiment

`memoization.js` reuses only derived preparation within one synchronous
evaluation of immutable network/fare snapshots. It retains the last graph
input/key and the last compiled fare index, with no passenger-sized cache.
`withEvaluationMemo` establishes a fresh scope per job and clears all retained
references in `finally`. Outside a scope, both accessors compute normally.

This is deliberately an explicit snapshot contract: mutating profiles or fare
arrays **inside** the scope is unsupported. Mutating the same objects between
fresh scopes works and is tested. Never wrap a live game session or a worker's
whole lifetime. A synchronous standalone evaluator call is the intended scope.

Private-copy source substitutions:

1. Prepend to `cross-tile-mode-choice.js`:

   ```js
   import { evaluationGraphKey } from '.../memoization.js';
   ```

   Replace the exact `getRouter` key expression:

   ```js
   const key = JSON.stringify(Object.entries(networkProfiles ?? {}).filter(([,p])=>p).sort(([a],[b])=>a.localeCompare(b)));
   ```

   with `const key = evaluationGraphKey(networkProfiles);`. Sorted tile IDs and
   their profile references are compared, permitting newly allocated outer
   wrapper objects for each demand batch. Changed profile references rebuild.
   The existing router World checks and exact key comparison stay in place.

2. Prepend to `journey-fare.js`:

   ```js
   import { evaluationFareIndex } from '.../memoization.js';
   ```

   Rename `function fareIndex(fareGroups, routes, legacyFare)` to
   `function uncachedFareIndex(fareGroups, routes, legacyFare)`, and append:

   ```js
   function fareIndex(fareGroups, routes, legacyFare) {
     return evaluationFareIndex(fareGroups, routes, legacyFare, uncachedFareIndex);
   }
   ```

   This covers both routing fare quotes and native-finance attribution without
   retaining journey results. The compiled Map is read-only to callers.

3. Export `withEvaluationMemo` from the same private esbuild bundle (the same
   module instance matters). Wrap the synchronous benchmark call:

   ```js
   const result = withEvaluationMemo(memo => {
     const result = evaluateOffTileNativeDemand(input);
     memoStats = { ...memo.stats };
     return result;
   });
   ```

   Read final hit/build stats before the scope exits if retained sizes are
   wanted. Counters and peak sizes survive cleanup; retained sizes become zero.
   `graphKeyBytes` estimates UTF-16 string bytes, and that string is shared with
   the router's existing cached key. `fareEntries` is the compiled route count.
   Neither number is a whole-process memory measurement.

Focused checks:

```powershell
node --test open-world-platform/experiments/commute-speed/memoization.test.js
```

The tests compare serialized keys and wrapped normal fare calculations directly
against the current source, including flat/route/distance groups, transfer
policies, temporary routes, changed snapshots, same-object mutations between
scopes, bounded last-entry replacement, nested scopes, and exception cleanup.
No timing claim is made before the root's combined full-network benchmark.
