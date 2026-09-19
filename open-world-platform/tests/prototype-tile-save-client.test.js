import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nativeSaveJsonChunks, slimExperimentalSaveDemand, writePrototypeNativeSave } from '../src/runtime/prototype-tile-save-client.js';

test('demand slimming drops journey-history rows while keeping topology, trains and the demand model', () => {
  const save = { id: 'slim', name: 'slim', cityCode: 'C', gameSessionId: 's', timestamp: 1, version: 4,
    data: { tracks: [{ id: 't' }], trains: [{ id: 'tr' }], routes: [], money: 5,
      compressedDemandData: { v: 2, p: [['pop', 1]], d: [['d', 2]], c: [{ p: 'pop', s: 3 }], m: { x: 1 } } } };
  const { save: slimmed, omittedJourneyRows } = slimExperimentalSaveDemand(save);
  assert.equal(omittedJourneyRows, 1);
  assert.deepEqual(slimmed.data.compressedDemandData, { v: 2, p: [['pop', 1]], d: [['d', 2]], c: [], m: { x: 1 } });
  assert.equal(slimmed.data.tracks, save.data.tracks, 'topology must stay shared, not cloned');
  assert.equal(slimmed.data.trains, save.data.trains, 'train inventory must stay shared, not cloned');
  assert.equal(save.data.compressedDemandData.c.length, 1, 'the native snapshot must not be mutated');
});

test('demand slimming is a no-op without a history array', () => {
  for (const data of [{}, { compressedDemandData: null }, { compressedDemandData: { v: 2, p: [] } }]) {
    const save = { data };
    assert.deepEqual(slimExperimentalSaveDemand(save), { save, omittedJourneyRows: 0 });
  }
});

test('chunked native JSON preserves values, duplicate references, Unicode and omitted properties', async () => {
  const shared = { route: '東京🚆', coords: [[1, 2], [3, 4]] };
  const save = { list: Array.from({ length: 200 }, () => shared), missing: undefined, values: [undefined, NaN, -0, Infinity],
    date: new Date('2026-01-01'), omitted: { toJSON: () => undefined }, keyed: { toJSON: key => key },
    escaped: 'quote"\nslash\\', empty: {}, sparse: Array(2) };
  const buffers = []; let yields = 0;
  for await (const bytes of nativeSaveJsonChunks(save, { chunkCharacters: 512, yieldTask: async () => { yields++; } })) buffers.push(bytes);
  assert.equal(Buffer.concat(buffers).toString(), JSON.stringify(save));
  assert.ok(yields > 1);
  assert.ok(Math.max(...buffers.map(b => b.length)) < 2048);
});

test('failed upload aborts, never commits, and keeps only one request in flight', async () => {
  const paths = []; let active = 0, peak = 0;
  const fetchFn = async (url, options) => {
    paths.push(url.pathname); peak = Math.max(peak, ++active); await Promise.resolve(); active--;
    if (url.pathname.endsWith('begin')) return Response.json({ id: 'test' });
    if (url.pathname.endsWith('abort')) return Response.json({ aborted: true });
    assert.equal(options.headers['X-Save-Chunk-Sha256'].length, 64);
    return new Response('fixture failure', { status: 500 });
  };
  await assert.rejects(writePrototypeNativeSave({ name: 'test', data: { a: 1 } }, { origin: 'http://127.0.0.1:8799', token: 'fixture', fetchFn }), /fixture failure/);
  assert.equal(peak, 1); assert.ok(paths.at(-1).endsWith('/abort')); assert.ok(paths.every(p => !p.endsWith('/commit')));
});

test('circular or unsupported huge values cannot publish a partial save', async () => {
  const value = {}; value.loop = value;
  await assert.rejects(async () => { for await (const _ of nativeSaveJsonChunks(value)) {} }, /Circular/);
  await assert.rejects(async () => { for await (const _ of nativeSaveJsonChunks({ s: 'x'.repeat(1024 * 1024 + 1) })) {} }, /large scalar/);
});

test('a lost commit response recovers the completed receipt without aborting', async () => {
  let bytes = 0, chunks = 0; const paths = [];
  const fetchFn = async (url, options) => {
    const action = url.pathname.split('/').at(-1); paths.push(action);
    if (action === 'begin') return Response.json({ id: 'test' });
    if (action === 'commit') throw new Error('Connection lost after rename');
    if (action === 'result') return Response.json({ bytes, chunks, path: 'fixture.metro' });
    bytes += options.body.length; chunks++; return Response.json({ accepted: true });
  };
  const result = await writePrototypeNativeSave({ data: [1, 2] }, { origin: 'http://127.0.0.1:8800', token: 'fixture', fetchFn });
  assert.equal(result.path, 'fixture.metro'); assert.equal(paths.includes('abort'), false);
});

test('a token-less upload rides the game-origin path without a control header', async () => {
  const headers = [];
  const fetchFn = async (url, options) => {
    headers.push(options.headers?.['X-PMTiles-Control-Token']);
    const action = url.pathname.split('/').at(-1);
    if (action === 'begin') return Response.json({ id: 'test' });
    if (action === 'commit') return Response.json({ bytes: 2, chunks: 1, path: 'fixture.metro' });
    return Response.json({ accepted: true });
  };
  const result = await writePrototypeNativeSave({ name: 'test', data: { a: 1 } }, { origin: 'http://127.0.0.1:8800', token: null, fetchFn });
  assert.equal(result.path, 'fixture.metro');
  assert.ok(headers.length > 0 && headers.every(header => header === undefined));
});

test('a rejected stable-state check discards the upload before publishing', async () => {
  const paths = [];
  const fetchFn = async url => { paths.push(url.pathname); return Response.json({ id: 'test' }); };
  await assert.rejects(writePrototypeNativeSave({ data: [1] }, { origin: 'http://127.0.0.1:8800', token: 'fixture', fetchFn,
    beforeCommit() { throw new Error('State changed'); } }), /State changed/);
  assert.equal(paths.some(path => path.endsWith('commit')), false); assert.ok(paths.at(-1).endsWith('abort'));
});

test('batched uploads preserve native JSON and checksums with frequent encoding yields', async () => {
  const save = { name: 'batch', data: Array.from({ length: 45000 }, (_, id) => ({ id, name: '東京🚆', values: [id, null, id / 3] })) };
  const uploaded = [], phases = []; let yields = 0, active = 0, peak = 0;
  const fetchFn = async (url, options) => {
    peak = Math.max(peak, ++active); await Promise.resolve(); active--;
    const action = url.pathname.split('/').at(-1);
    if (action === 'begin') { assert.equal(phases.at(-1), 'connecting'); return Response.json({ id: 'batch' }); }
    if (action === 'commit') {
      assert.equal(phases.at(-1), 'finalizing');
      return Response.json({ ...JSON.parse(options.body), path: 'batch.metro' });
    }
    assert.equal(Number(action), uploaded.length);
    assert.equal(options.headers['X-Save-Chunk-Sha256'], createHash('sha256').update(options.body).digest('hex'));
    assert.ok(options.body.length <= 4 * 1024 * 1024);
    uploaded.push(options.body);
    return Response.json({ accepted: true });
  };
  const result = await writePrototypeNativeSave(save, { origin: 'http://127.0.0.1:8800', fetchFn,
    yieldTask: async () => { yields++; }, onProgress: value => phases.push(value.phase) });
  const expected = JSON.stringify(save);
  assert.equal(Buffer.concat(uploaded).toString(), expected);
  assert.equal(result.bytes, Buffer.byteLength(expected));
  assert.equal(result.chunks, uploaded.length);
  assert.ok(uploaded.length > 1);
  assert.ok(yields > uploaded.length * 2, 'encoding must keep yielding while requests are batched');
  assert.equal(peak, 1);
});

test('unreadable commit receipts report an unknown outcome instead of claiming no save exists', async () => {
  for (const receipt of [new Response('missing', { status: 404 }), new Response('{'), Response.json(null), Response.json({ chunks: 99, bytes: 99 })]) {
    const fetchFn = async url => {
      const action = url.pathname.split('/').at(-1);
      if (action === 'begin') return Response.json({ id: 'test' });
      if (action === 'commit') throw new Error('Commit response lost');
      if (action === 'result') return receipt;
      return Response.json({ accepted: true });
    };
    await assert.rejects(writePrototypeNativeSave({ data: [1] }, { origin: 'http://127.0.0.1:8800', fetchFn }),
      error => error.saveOutcome === 'unknown' && error.message === 'Commit response lost');
  }
});
