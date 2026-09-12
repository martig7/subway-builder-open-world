import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMonitorOptions, selectGameTarget, compactMemorySnapshot, SequentialCdpClient, monitorRendererMemory,
} from '../scripts/monitor-renderer-memory.mjs';

const target = {
  type: 'page', id: 'renderer-1', title: 'Subway Builder',
  url: 'file:///C:/Games/Subway%20Builder/resources/app.asar/dist/renderer/index.html#NEC',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/renderer-1',
};

test('collector requires an explicit output and rejects unsafe endpoints or invalid sampling options', () => {
  assert.throws(() => parseMonitorOptions([]), /--output is required/);
  const parsed = parseMonitorOptions(['--output', 'capture.jsonl']);
  assert.equal(parsed.url, 'http://127.0.0.1:9222');
  assert.equal(parsed.intervalMs, 1000);
  assert.equal(parsed.durationMs, 900000);
  for (const url of ['https://localhost:9222', 'http://example.com:9222', 'http://user:secret@localhost:9222', 'http://localhost:9222/other']) {
    assert.throws(() => parseMonitorOptions(['--output', 'capture.jsonl', '--url', url]), /loopback HTTP origin/);
  }
  for (const [key, value] of [['--duration-seconds', '0'], ['--interval-ms', '1'], ['--timeout-ms', 'NaN']]) {
    assert.throws(() => parseMonitorOptions(['--output', 'capture.jsonl', key, value]), /must be an integer/);
  }
  assert.throws(() => parseMonitorOptions(['--output', 'one', '--output', 'two']), /repeated option/);
});

test('collector selects only the identified game page and refuses ambiguous or redirected websocket targets', () => {
  const origin = 'http://127.0.0.1:9222';
  assert.equal(selectGameTarget([{ ...target, type: 'worker' }, { ...target, title: 'Other app' }], origin), null);
  assert.equal(selectGameTarget([{ ...target, url: 'file:///other/index.html' }], origin), null);
  assert.equal(selectGameTarget([target], origin).id, 'renderer-1');
  assert.throws(() => selectGameTarget([target, { ...target, id: 'renderer-2' }], origin), /Multiple/);
  assert.throws(() => selectGameTarget([{ ...target, webSocketDebuggerUrl: 'ws://elsewhere:9222/target' }], origin), /loopback CDP port/);
});

test('persisted diagnostic messages contain bounded scalar data and no history or unknown objects', () => {
  const event = { id: 1, activity: 'x'.repeat(1000), usedBytes: 123, game: { huge: true } };
  const report = compactMemorySnapshot({ version: 'v1', captureId: 'capture', running: true,
    samples: new Array(2000).fill(event), latest: event, highWater: event,
    events: new Array(100).fill(event), activities: new Array(60).fill(event),
    summary: { samples: 50000, game: { huge: true } } });
  assert.equal(report.events.length, 16);
  assert.equal(report.activities.length, 8);
  assert.equal(report.omittedEvents, 84);
  assert.equal(report.omittedActivities, 52);
  assert.equal(report.latest.activity.length, 160);
  assert.equal('samples' in report, false);
  assert.equal('game' in report.latest, false);
  assert.equal('game' in report.summary, false);
  assert.ok(JSON.stringify(report).length < 8000);
});

class FakeSocket extends EventTarget {
  sent = [];
  closeCount = 0;
  send(message) { this.sent.push(JSON.parse(message)); }
  close() { this.closeCount++; }
  reply(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
}

test('a frozen renderer retains one outstanding request until it responds or disconnects', async () => {
  const socket = new FakeSocket(), client = new SequentialCdpClient(socket);
  const pending = client.call('Runtime.evaluate');
  for (let retry = 0; retry < 100; retry++) {
    await assert.rejects(client.call('Runtime.evaluate'), /already outstanding/);
  }
  assert.equal(socket.sent.length, 1);
  socket.reply({ id: 1, result: { done: true } });
  assert.deepEqual(await pending, { done: true });
  const next = client.call('Runtime.getHeapUsage');
  client.close();
  await assert.rejects(next, /Collector stopped/);
  client.close();
  assert.equal(client.pending, null);
  assert.equal(socket.closeCount, 1);
});

test('an oversized message or renderer crash closes and rejects the pending request once', async () => {
  for (const crash of [false, true]) {
    const socket = new FakeSocket(), received = [];
    const client = new SequentialCdpClient(socket, (method) => received.push(method));
    const pending = client.call('Runtime.evaluate');
    if (crash) socket.reply({ method: 'Inspector.targetCrashed', params: {} });
    else socket.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(300000) }));
    await assert.rejects(pending, crash ? /Inspector.targetCrashed/ : /bounded collector limit/);
    assert.equal(client.closed, true);
    assert.equal(socket.closeCount, 1);
    assert.deepEqual(received, crash ? ['Inspector.targetCrashed'] : []);
  }
});

test('collector persists heap before a frozen evaluation and shuts down without issuing more renderer commands', async () => {
  for (const freeze of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'open-world-memory-monitor-'));
    const output = join(directory, 'capture.jsonl');
    const controller = new AbortController();
    let socket;
    class RendererSocket extends FakeSocket {
      constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(message) {
        super.send(message);
        const request = JSON.parse(message);
        if (request.method === 'Runtime.evaluate' && freeze) return;
        const result = request.method === 'Runtime.getHeapUsage'
          ? { usedSize: 123, totalSize: 456, backingStorageSize: 78, embedderHeapUsedSize: 9 }
          : request.method === 'Runtime.evaluate' ? { result: { value: { timeOrigin: 1, reportedLimitBytes: 1000,
            diagnostic: { captureId: 'one', latest: { id: 1 }, summary: { activities: 0 }, events: [], activities: [] } } } } : {};
        queueMicrotask(() => this.reply({ id: request.id, result }));
      }
    }
    const timeout = setTimeout(() => controller.abort(), 80);
    try {
      await monitorRendererMemory({ output, url: 'http://127.0.0.1:9222', intervalMs: 10, timeoutMs: 15 }, {
        signal: controller.signal, WebSocketCtor: RendererSocket,
        fetchFn: async () => ({ ok: true, text: async () => JSON.stringify([target]) }),
      });
      const records = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const sample = records.find(record => record.kind === 'sample');
      assert.equal(sample.usedBytes, 123);
      assert.equal(sample.backingStorageBytes, 78);
      assert.equal(sample.embedderHeapUsedBytes, 9);
      assert.equal(records.at(-1).kind, 'stopped');
      assert.equal(socket.closeCount, 1);
      if (freeze) {
        assert.equal(records.filter(record => record.kind === 'unresponsive').length, 1);
        assert.deepEqual(socket.sent.map(request => request.method), ['Inspector.enable', 'Runtime.getHeapUsage', 'Runtime.evaluate']);
        assert.equal(records.filter(record => record.kind === 'diagnostic').length, 0);
      } else {
        assert.equal(records.find(record => record.kind === 'diagnostic').headroomBytes, 877);
        assert.match(socket.sent.find(request => request.method === 'Runtime.evaluate').params.expression, /includeHistory":false/);
      }
    } finally {
      clearTimeout(timeout);
      rmSync(output, { force: true });
      rmdirSync(directory);
    }
  }
});
