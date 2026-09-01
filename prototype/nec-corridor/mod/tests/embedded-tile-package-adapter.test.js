import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmbeddedTilePackageAdapter,
  createOffMainThreadJsonDecoder,
  createOffMainThreadNativeDemandEvaluator,
} from '../src/embedded-tile-package-adapter.js';
import { tileCatalog } from '../src/tile-catalog.js';

test('native demand transfers gzip decode and JSON parsing to a worker', async () => {
  const expected = {
    points: [{ id: 'point-1' }],
    pops: [{ id: 'pop-1' }],
  };
  const workerCalls = [];
  const revokedUrls = [];
  let terminated = false;

  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
    }

    set onmessage(handler) {
      this.messageHandler = handler;
      queueMicrotask(() => handler({ data: { type: 'ready' } }));
    }

    get onmessage() {
      return this.messageHandler;
    }

    postMessage(message, transfer) {
      workerCalls.push({ message, transfer, url: this.url, options: this.options });
      queueMicrotask(() => this.onmessage?.({
        data: { id: message.id, ok: true, value: expected },
      }));
    }

    terminate() {
      terminated = true;
    }
  }

  const decoder = createOffMainThreadJsonDecoder({
    WorkerClass: FakeWorker,
    BlobClass: class FakeBlob {},
    createObjectURL: () => 'blob:nec-demand-decoder-test',
    revokeObjectURL: (url) => revokedUrls.push(url),
  });
  const tileId = tileCatalog.tiles[0].id;
  const adapter = new EmbeddedTilePackageAdapter([tileId], {}, {
    fetchData: async () => ({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]).buffer,
    }),
    resolveDataUrl: (path) => `http://127.0.0.1:55165${path}`,
    decodeJsonBytes: decoder.decode,
  });

  assert.deepEqual(await adapter.loadNativeDemand(tileId), expected);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].message.gzip, true);
  assert.deepEqual(workerCalls[0].transfer, [workerCalls[0].message.bytes]);
  assert.equal(workerCalls[0].options.name, 'nec-demand-json-decoder');

  decoder.dispose();
  assert.equal(terminated, true);
  assert.deepEqual(revokedUrls, ['blob:nec-demand-decoder-test']);
});

test('native demand evaluation returns a compact profile without transferring parsed demand to the renderer', async () => {
  const workerCalls = [];
  const compactResult = {
    status: 'evaluated',
    profile: {
      source: 'off-tile-estimator',
      tileId: tileCatalog.tiles[0].id,
      dailyRevenue: 12_345,
      hourly: Array(24).fill(0),
    },
  };

  class FakeWorker {
    set onmessage(handler) {
      this.messageHandler = handler;
      queueMicrotask(() => handler({ data: { type: 'ready' } }));
    }

    get onmessage() {
      return this.messageHandler;
    }

    postMessage(message, transfer) {
      workerCalls.push({ message, transfer });
      queueMicrotask(() => this.onmessage?.({
        data: { id: message.id, ok: true, value: compactResult },
      }));
    }

    terminate() {}
  }

  const evaluator = createOffMainThreadNativeDemandEvaluator({
    WorkerClass: FakeWorker,
    BlobClass: class FakeBlob {},
    createObjectURL: () => 'blob:nec-native-demand-evaluator-test',
    revokeObjectURL: () => {},
    workerSource: '/* canonical evaluator bundle */',
  });
  const tileId = tileCatalog.tiles[0].id;
  const networkProfile = {
    schemaVersion: 1,
    tileId,
    structuralSignature: 'network-v1',
    stations: [],
    routes: [],
    trains: [],
  };
  const globalNativeState = {
    routes: [{ id: 'R', tempParentId: null, stNodes: Array(10_000).fill({ id: 'node' }) }],
    fareGroups: [{ id: 'default', routeIds: ['R'], flatFare: 2.5 }],
    tracks: Array(10_000).fill({ id: 'track' }),
  };
  const adapter = new EmbeddedTilePackageAdapter([tileId], {}, {
    fetchData: async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array(2_000_000).buffer,
    }),
    resolveDataUrl: (path) => `http://127.0.0.1:55165${path}`,
    decodeJsonBytes: () => {
      throw new Error('parsed native demand reached the renderer');
    },
    evaluateNativeDemandBytes: evaluator.evaluate,
  });

  const result = await adapter.evaluateNativeDemand({
    tileId,
    networkProfile,
    farePolicy: { fare: 2.5 },
    globalNativeState,
    financeOwnedRouteIds: [],
    existingProfile: null,
  });

  assert.deepEqual(result, compactResult);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].message.gzip, false);
  assert.equal(workerCalls[0].message.input.tileId, tileId);
  assert.equal(workerCalls[0].message.input.networkProfile, networkProfile);
  assert.deepEqual(workerCalls[0].message.input.globalNativeState, {
    routes: [{ id: 'R', tempParentId: null }],
    fareGroups: [{
      id: 'default',
      fareSystem: undefined,
      flatFare: 2.5,
      routeFares: undefined,
      routeIds: ['R'],
      transferPolicy: undefined,
      chargeOnInterGroupTransfer: undefined,
      boardingCharge: undefined,
      perKmRate: undefined,
      fareCap: undefined,
    }],
  });
  assert.equal('demand' in workerCalls[0].message, false);
  assert.deepEqual(workerCalls[0].transfer, [workerCalls[0].message.bytes]);
  assert.equal('points' in result, false);
  assert.equal('pops' in result, false);

  evaluator.dispose();
});

test('road routing reads the selected tile gzip bytes through the renderer data URL', async () => {
  const tileId = tileCatalog.tiles[0].id;
  const requested = [];
  const adapter = new EmbeddedTilePackageAdapter([tileId], {}, {
    fetchData: async (url) => {
      requested.push(url);
      return { ok: true, arrayBuffer: async () => Uint8Array.from([0x1f, 0x8b, 0x08]).buffer };
    },
    resolveDataUrl: (path) => `http://127.0.0.1:55165${path}`,
  });
  assert.deepEqual([...await adapter.loadRoadBytes(tileId)], [0x1f, 0x8b, 0x08]);
  assert.deepEqual(requested, [`http://127.0.0.1:55165/data/${tileId}/roads.geojson.gz`]);
});
