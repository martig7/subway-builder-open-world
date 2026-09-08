import test from 'node:test';
import assert from 'node:assert/strict';
import { attachGlyphWarmup, GLYPH_WARMUP_VERSION } from '../src/runtime/ui/glyph-warmup.js';

function fixture(options = {}) {
  const tasks = new Map(); let next = 0, moving = false, calls = 0, clock = 0;
  const entry = { glyphs: { 28450: { bitmap: { data: new Uint8Array(4) } } } };
  const manager = { localIdeographFontFamily: 'sans-serif', entries: { 'Noto Sans Medium': entry },
    _doesCharSupportLocalGlyph: code => code >= 0x3000,
    _tinySDF() { calls++; clock += .8; entry.tinySDF ??= { grid: new Uint8Array(8) }; return { bitmap: { data: new Uint8Array(16) } }; } };
  const handlers = new Map();
  const map = { style: { glyphManager: manager }, isMoving: () => moving,
    on(event, fn) { const xs = handlers.get(event) ?? new Set(); xs.add(fn); handlers.set(event, xs); },
    off(event, fn) { handlers.get(event)?.delete(fn); } };
  const config = { maxGlyphs: 5, maxBytes: 1024, fonts: { load: async () => [] },
    now: () => clock, schedule: fn => { tasks.set(++next, fn); return next; }, cancel: id => tasks.delete(id), ...options };
  const attach = () => attachGlyphWarmup(map, config);
  async function drain() {
    for (let i = 0; i < 50; i++) {
      await Promise.resolve(); const item = tasks.entries().next().value;
      if (!item) return;
      tasks.delete(item[0]); item[1]({ timeRemaining: () => 10 });
    }
    throw Error('warmup failed to settle');
  }
  return { map, manager, entry, attach, drain, config, tasks, calls: () => calls,
    move(value) { moving = value; if (!value) for (const fn of handlers.get('moveend') ?? []) fn(); } };
}

test('warms native cache in short idle slices, preserves hits, and stops at glyph budget', async () => {
  const f = fixture(), retained = f.entry.glyphs[28450], c = f.attach();
  await f.drain();
  assert.equal(f.calls(), 5);
  assert.strictEqual(f.entry.glyphs[28450], retained);
  assert.equal(c.diagnostic.addedBufferBytes, 88);
  assert.ok(c.diagnostic.maxSliceMs <= 2.5);
  assert.equal(c.diagnostic.status, 'budget-reached');
});

test('movement defers warmup and disposal cancels pending work', async () => {
  const f = fixture(); f.move(true); const c = f.attach(); await f.drain();
  assert.equal(f.calls(), 0);
  f.move(false); await f.drain(); assert.equal(f.calls(), 5);
  c.dispose(); assert.equal(f.map.__openWorldGlyphWarmup, undefined);
  const other = fixture(); const d = other.attach(); d.dispose(); await other.drain(); assert.equal(other.calls(), 0);
});

test('budget includes new scratch arrays and rejects oversize speculative glyphs', async () => {
  const f = fixture({ maxBytes: 12 }), c = f.attach(); await f.drain();
  assert.equal(Object.keys(f.entry.glyphs).length, 1);
  assert.ok(c.diagnostic.addedBufferBytes <= 12);
});

test('a delayed font load cannot warm an old style and new style resumes', async () => {
  let done, loads = 0; const f = fixture({ fonts: { load: () => new Promise(r => { loads++; done = r; }) } });
  const c = f.attach(); await f.drain();
  const replacement = fixture().manager; f.map.style.glyphManager = replacement;
  done([]); await f.drain();
  assert.equal(f.calls(), 0);
  assert.equal(loads, 2, 'new style must restart after the old font promise resolves');
  assert.equal(c.diagnostic.status, 'loading-font');
  assert.ok(done); c.dispose(); done([]); await f.drain();
});

test('reloading does not reset the native manager warmup budget; old generation is disposed', async () => {
  const f = fixture(), first = f.attach(); await f.drain();
  first.version = 'older-glyph-warmup';
  const next = f.attach(); await f.drain();
  assert.notStrictEqual(next, first);
  assert.equal(next.version, GLYPH_WARMUP_VERSION);
  assert.equal(f.calls(), 5);
});

test('Latin-only maps and unsupported native versions do no speculative CJK work', async () => {
  const f = fixture(); f.entry.glyphs = { 65: {} }; f.attach(); await f.drain(); assert.equal(f.calls(), 0);
  const other = fixture(); delete other.manager._tinySDF; other.attach(); await other.drain(); assert.equal(other.calls(), 0);
});

test('failed generation releases speculative scratch buffers and leaves native cache alone', async () => {
  const f = fixture();
  f.manager._tinySDF = () => { f.entry.tinySDF = { grid: new Uint8Array(1024) }; throw Error('font failure'); };
  const c = f.attach(); await f.drain();
  assert.equal(f.entry.tinySDF, undefined);
  assert.equal(Object.keys(f.entry.glyphs).length, 1);
  assert.equal(c.diagnostic.addedBufferBytes, 0);
  assert.ok(c.diagnostic.errors > 0);
});
