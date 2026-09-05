import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMapLabelPolicy } from '../src/mod-builder/build-world-mod.js';

test('map publication policy blocks raw or stale labels without affecting other worlds', () => {
  const definition = { map: { labelPolicy: 'japan-source-romaji-v1' } };
  assert.throws(() => assertMapLabelPolicy(definition, {}, 'JP_PREF_27'), /run the World's label publication stage/);
  assert.throws(() => assertMapLabelPolicy(definition, { labelPolicy: 'older' }, 'JP_PREF_27'), /does not match/);
  assert.doesNotThrow(() => assertMapLabelPolicy(definition, { labelPolicy: 'japan-source-romaji-v1' }, 'JP_PREF_27'));
  assert.doesNotThrow(() => assertMapLabelPolicy({ map: {} }, {}, 'NEC_TEST'));
});
