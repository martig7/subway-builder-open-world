import test from 'node:test';
import assert from 'node:assert/strict';
import { yieldBrowserPaint } from '../src/runtime/frame-budget.js';

test('blocking work resumes after animation frame callbacks and their paint, not inside the frame', async () => {
  const previous = globalThis.requestAnimationFrame;
  const frames = [], events = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  try {
    const ready = yieldBrowserPaint().then(() => events.push('work'));
    frames.shift()();
    frames.shift()();
    await Promise.resolve();
    assert.deepEqual(events, [], 'a resolved frame callback must not start work before paint');
    events.push('paint');
    await ready;
    assert.deepEqual(events, ['paint', 'work']);
  } finally {
    if (previous === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previous;
  }
});
