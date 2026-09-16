import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSaveJsonChunks, writePrototypeNativeSave } from '../src/runtime/prototype-tile-save-client.js';

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
