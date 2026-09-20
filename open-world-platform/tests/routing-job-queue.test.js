import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runRoutingJob } from '../src/runtime/routing-job-queue.js';

test('routing jobs remain serial, return their own values, and recover after a failure', async () => {
  const events = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = runRoutingJob(async () => { events.push('first'); await blocked; return { profile: 'first' }; });
  const second = runRoutingJob(() => { events.push('second'); throw new Error('failed job'); });
  const rejected = assert.rejects(second, /failed job/);
  const third = runRoutingJob(() => { events.push('third'); return { profile: 'third' }; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first']);
  release();
  assert.deepEqual(await first, { profile: 'first' });
  await rejected;
  assert.deepEqual(await third, { profile: 'third' });
  assert.deepEqual(events, ['first', 'second', 'third']);
});

test('an idle routing queue does not retain the last completed profile or assignments', () => {
  const queueUrl = new URL('../src/runtime/routing-job-queue.js', import.meta.url).href;
  const probe = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=64', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { runRoutingJob } from ${JSON.stringify(queueUrl)};
    async function calculate() {
      const result = await runRoutingJob(() => ({
        profile: { hourly: [] }, assignments: [{ id: 'cohort', geometry: new Uint8Array(2 * 1024 * 1024) }],
      }));
      assert.equal(result.assignments[0].id, 'cohort');
      return new WeakRef(result);
    }
    const reference = await calculate();
    let retained = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
      global.gc();
      await new Promise(resolve => setImmediate(resolve));
      if (reference.deref() === undefined) { retained = false; break; }
    }
    assert.equal(retained, false, 'idle routing queue retained its completed result after the caller released it');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message || probe.stdout);
});
