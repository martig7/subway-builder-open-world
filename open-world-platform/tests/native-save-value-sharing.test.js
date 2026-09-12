import test from 'node:test';
import assert from 'node:assert/strict';
import { shareNativeSaveValueReferences } from '../src/runtime/native-save-value-sharing.js';
import { shareNativeSaveReferences } from '../src/runtime/native-save-reference-sharing.js';

test('native demand summaries and financial breakdowns share equal values without trimming records', () => {
  const summary = () => [1, 2, 3, 4, 5, 6, 0.9];
  const breakdown = () => ({ trackMaintenance: 150, stationMaintenance: 200 });
  const save = { data: {
    compressedDemandData: { v: 2, p: [['p', 100, 200, summary(), summary(), 0]],
      d: [['a', [0, 0, 0, 0], [0, 0, 0, 0]], ['b', [0, 0, 0, 0], [0, 0, 0, 0]]] },
    financialHistory: { expenses: [{ timestamp: 1, categories: breakdown() }, { timestamp: 2, categories: breakdown() }] },
    money: 700, tracks: [{ id: 'native-track' }],
  } };
  const before = structuredClone(save), result = shareNativeSaveReferences(save);
  assert.deepEqual(result, before);
  assert.deepEqual(save, before);
  assert.equal(result.data.compressedDemandData.p[0][3], result.data.compressedDemandData.p[0][4]);
  assert.equal(result.data.compressedDemandData.d[0][1], result.data.compressedDemandData.d[1][2]);
  assert.equal(result.data.financialHistory.expenses[0].categories, result.data.financialHistory.expenses[1].categories);
  assert.equal(result.data.tracks, save.data.tracks);
  assert.equal(shareNativeSaveReferences(result), result);
});

test('hash collisions, different property order and special scalar values cannot change native values', () => {
  // These distinct strings have the same FNV-1a hash.
  const input = [{ value: 'costarring' }, { value: 'liquid' }, { value: -0 }, { value: 0 },
    { value: undefined }, {}, { value: NaN }, { value: Infinity }, { a: 1, b: 2 }, { b: 2, a: 1 }];
  const result = shareNativeSaveValueReferences(input);
  assert.deepEqual(result, input);
  assert.equal(new Set(result).size, input.length);
  assert.ok(Object.is(result[2].value, -0));
  assert.equal(Object.hasOwn(result[4], 'value'), true);
});

test('sharing keeps unknown native objects, accessors, sparse arrays and cycles intact', () => {
  let getterCalls = 0;
  const getter = { get value() { getterCalls++; return [1, 2]; } };
  const hidden = Object.defineProperty({ value: 1 }, 'hidden', { value: 9 });
  const symbolic = { value: 1, [Symbol('extra')]: 2 };
  const sparse = []; sparse.length = 20; sparse[0] = [1, 2];
  const decorated = [1, 2]; decorated.extra = 3;
  const date = new Date(0), typed = new Uint8Array([1, 2]);
  const serialized = { rows: [[1, 2], [1, 2]], toJSON() { throw new Error('Do not call custom serialization'); } };
  const input = [getter, hidden, symbolic, sparse, decorated, date, typed, serialized, { callback() {} }, { value: 1n }];
  assert.equal(shareNativeSaveValueReferences(input), input);
  assert.equal(getterCalls, 0);
  const cycle = { rows: [[1, 2], [1, 2]] }; cycle.self = cycle;
  assert.equal(shareNativeSaveValueReferences(cycle), cycle);
  assert.notEqual(cycle.rows[0], cycle.rows[1]);
});

test('sharing scratch tables and visited nodes remain capped and are scoped to each save field', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [i % 20, i % 10]);
  let stats;
  const result = shareNativeSaveValueReferences(rows, { maxEntries: 5, maxNodes: 40, onStats: value => { stats = value; } });
  assert.deepEqual(result, rows);
  assert.ok(stats.entries <= 5);
  assert.ok(stats.visited <= 40);
  const other = structuredClone(rows);
  const next = shareNativeSaveValueReferences(other);
  assert.notEqual(next[0], result[0]);
  assert.equal(shareNativeSaveValueReferences(rows, { maxEntries: 0 }), rows);
});
