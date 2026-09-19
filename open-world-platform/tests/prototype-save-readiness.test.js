import test from 'node:test';
import assert from 'node:assert/strict';
import { prototypeSaveBusyReason } from '../src/runtime/prototype-save-readiness.js';

test('observed idle simulation does not need native worker construction, but queued work still blocks', () => {
  const simulation = { status: 'ready', saveWork: { observed: true, native: 0, cached: false } };
  for (const nativeWorkers of [undefined, { logicalWorkers: 0, busy: 0, queued: 0 }, { logicalWorkers: 24, busy: 0, queued: 0 }])
    assert.equal(prototypeSaveBusyReason({ nativeWorkers, simulation }), false);
  for (const nativeWorkers of [{ busy: 1, queued: 0 }, { busy: 0, queued: 3 }])
    assert.match(prototypeSaveBusyReason({ nativeWorkers, simulation }), /Waiting for journey calculations/);
  assert.match(prototypeSaveBusyReason({ simulation: { ...simulation, status: 'calculating' } }), /cached journey calculations/);
  assert.match(prototypeSaveBusyReason({}), /Cannot observe/);
});
