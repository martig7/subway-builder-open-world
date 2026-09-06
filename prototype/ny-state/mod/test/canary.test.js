import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  cityDefinitionsFor,
  refreshPilotCityBindings,
  registerPilotCities,
  repairPilotMapCamera,
  repairPilotMapTileSource,
} from '../src/city-registration.js';
import { EmbeddedTilePackageAdapter, resolveRendererDataUrl } from '../src/embedded-tile-package-adapter.js';
import { PILOT_TILE_IDS, tileCatalog } from '../src/tile-catalog.js';

test('canary exposes exactly the seven corridor packages', () => {
  assert.equal(tileCatalog.tiles.length, 7);
  assert.deepEqual(tileCatalog.tiles.map((tile) => tile.id).sort(), [...PILOT_TILE_IDS].sort());
  for (const tile of tileCatalog.tiles) {
    assert.equal(tile.boundary.length, 5, `${tile.id} should have a closed projected-cell outline`);
    assert.deepEqual(tile.boundary[0], tile.boundary.at(-1), `${tile.id} outline should be closed`);
  }
  assert.equal(cityDefinitionsFor().length, 7);
});

test('registered cities declare the basemap zoom floor to the native renderer', () => {
  const definitions = cityDefinitionsFor();
  assert.ok(definitions.length > 0);
  // The game reads `city.minZoom || 10`, so exact zero would silently restore
  // its native zoom-10 clamp even though the PMTiles archive reaches zoom 0.
  assert.ok(definitions.every((city) => city.minZoom === 0.01));
  assert.ok(definitions.every((city) => (city.minZoom || 10) < 0.1));
});

test('hot reload repairs the zoom floor on an already registered city', () => {
  const existing = { code: PILOT_TILE_IDS[0] };
  const registered = [];
  const api = {
    registerCity: (city) => registered.push(city),
    utils: { getCities: () => [existing, ...registered] },
    cities: { setCityDataFiles() {} },
    map: { setTileURLOverride() {}, setDefaultLayerVisibility() {} },
  };

  registerPilotCities(api);
  assert.equal(existing.minZoom, 0.01);
  assert.equal(registered.some((city) => city.code === existing.code), false);
});

test('every pilot package has a complete spatial 3x3 edit window', () => {
  for (const active of tileCatalog.tiles) {
    const cells = tileCatalog.spatialTiles.filter((tile) => (
      Math.max(Math.abs(tile.column - active.column), Math.abs(tile.row - active.row)) <= 1
    ));
    assert.equal(cells.length, 9, active.id);
  }
});

test('each city receives its own PMTiles URL and native data namespace', () => {
  const cities = [];
  const files = new Map();
  const urls = new Map();
  const api = {
    registerCity: (city) => cities.push(city),
    utils: { getCities: () => [] },
    cities: { setCityDataFiles: (code, value) => files.set(code, value) },
    map: {
      setTileURLOverride: ({ cityCode, tilesUrl }) => urls.set(cityCode, tilesUrl),
      setDefaultLayerVisibility() {},
    },
  };
  const result = registerPilotCities(api, { tileBase: 'http://tiles.test' });
  assert.equal(cities.length, 7);
  assert.deepEqual([...result.tileIds].sort(), [...PILOT_TILE_IDS].sort());
  for (const tileId of PILOT_TILE_IDS) {
    assert.equal(urls.get(tileId), `http://tiles.test/${tileId}/{z}/{x}/{y}.mvt?v=world-z0-z9-v2`);
    assert.equal(files.get(tileId).demandData, `/data/${tileId}/demand_data.json.gz`);
  }
});

test('city-load rebinding repairs a tile override that the native API silently dropped', () => {
  const urls = new Map();
  let rp02Attempts = 0;
  const api = {
    registerCity() {},
    utils: { getCities: () => [] },
    cities: { setCityDataFiles() {} },
    map: {
      setTileURLOverride: ({ cityCode, tilesUrl }) => {
        if (cityCode === 'NY_CP00_RP02' && rp02Attempts++ === 0) return;
        urls.set(cityCode, tilesUrl);
      },
      setDefaultLayerVisibility() {},
    },
  };
  registerPilotCities(api, { tileBase: 'http://tiles.test' });
  assert.equal(urls.has('NY_CP00_RP02'), false);
  refreshPilotCityBindings(api, { tileBase: 'http://tiles.test', cityCodes: ['NY_CP00_RP02'] });
  assert.equal(urls.get('NY_CP00_RP02'), 'http://tiles.test/NY_CP00_RP02/{z}/{x}/{y}.mvt?v=world-z0-z9-v2');
});

test('map-ready repair replaces a memoized map protocol fallback on the live vector source', () => {
  const changes = [];
  const styleChanges = [];
  const style = {
    version: 8,
    sources: {
      'general-tiles': {
        type: 'vector',
        tiles: ['map://NY_CP00_RP02/tiles/{z}/{x}/{y}.mvt'],
        maxzoom: 15,
      },
    },
    layers: [],
  };
  const source = {
    tiles: ['map://NY_CP00_RP02/tiles/{z}/{x}/{y}.mvt'],
    // Reproduces the native transition failure: MapLibre exposes setTiles,
    // but the stale React-owned style immediately remains authoritative.
    setTiles: (tiles) => changes.push(tiles),
  };
  const result = repairPilotMapTileSource(
    {
      getSource: (id) => id === 'general-tiles' ? source : null,
      getStyle: () => structuredClone(style),
      setStyle: (nextStyle, options) => {
        styleChanges.push({ nextStyle, options });
        style.sources = structuredClone(nextStyle.sources);
      },
    },
    'NY_CP00_RP02',
    { tileBase: 'http://tiles.test' },
  );
  assert.equal(result.status, 'repaired');
  assert.deepEqual(changes, [['http://tiles.test/NY_CP00_RP02/{z}/{x}/{y}.mvt?v=world-z0-z9-v2']]);
  assert.equal(styleChanges.length, 1);
  assert.deepEqual(style.sources['general-tiles'].tiles, [
    'http://tiles.test/NY_CP00_RP02/{z}/{x}/{y}.mvt?v=world-z0-z9-v2',
  ]);
});

test('map-ready repair recenters a detailed stale camera into the selected tile', () => {
  const jumps = [];
  const result = repairPilotMapCamera({
    getCenter: () => ({ lng: -73.98, lat: 40.74 }),
    getZoom: () => 13,
    jumpTo: (options) => jumps.push(options),
  }, 'NY_CP00_RP02');

  assert.equal(result.status, 'recentered');
  assert.deepEqual(jumps, [{
    center: [-73.8739023, 42.68592605],
    zoom: 9,
    bearing: 0,
  }]);
});

test('map-ready repair preserves an intentional world overview', () => {
  const jumps = [];
  const result = repairPilotMapCamera({
    getCenter: () => ({ lng: -73.98, lat: 40.74 }),
    getZoom: () => 7,
    jumpTo: (options) => jumps.push(options),
  }, 'NY_CP00_RP02');

  assert.equal(result.status, 'world-view');
  assert.deepEqual(jumps, []);
});

test('embedded package manifests expose cross-tile runtime data', async () => {
  const crossDemand = { schemaVersion: 1, tileId: 'GLOBAL', points: [] };
  const adapter = new EmbeddedTilePackageAdapter(PILOT_TILE_IDS, {
    commuteCatalog: { schemaVersion: 1, tileId: 'GLOBAL', buckets: [], gateways: [] },
    crossDemandGzipBase64: gzipSync(JSON.stringify(crossDemand)).toString('base64'),
  });
  const pkg = await adapter.prepare('NY_CP00_RP00');
  assert.equal(pkg.manifest.dataFiles.buildingsIndex, 'buildings_index.bin.gz');
  assert.equal(pkg.manifest.runtimeFiles.crossCommutes.storage, 'bundle');
  assert.equal(pkg.manifest.runtimeFiles.crossCommutes.path, undefined);
  assert.deepEqual(await adapter.loadCommuteCatalog('NY_CP00_RP00'), {
    schemaVersion: 1,
    tileId: 'NY_CP00_RP00',
    buckets: [],
    gateways: [],
  });
  assert.deepEqual(await adapter.loadCrossDemand('NY_CP01_RP00'), {
    schemaVersion: 1,
    tileId: 'NY_CP01_RP00',
    points: [],
  });
});

test('embedded packages load another tile native demand without adopting that city', async () => {
  const reads = [];
  const nativeDemand = {
    points: [{ id: 'home', location: [-73.8, 42.7] }],
    pops: [{ id: 'pop', residenceId: 'home', jobId: 'home', size: 50 }],
  };
  const adapter = new EmbeddedTilePackageAdapter(PILOT_TILE_IDS, {}, {
    loadCityData: async (path) => { reads.push(path); return nativeDemand; },
  });

  assert.deepEqual(await adapter.loadNativeDemand('NY_CP00_RP02'), nativeDemand);
  assert.deepEqual(await adapter.loadNativeDemand('NY_CP00_RP02'), nativeDemand);
  assert.deepEqual(reads, ['/data/NY_CP00_RP02/demand_data.json.gz']);
});

test('inactive native demand uses HTTP data reads instead of the broken dynamic-import API', async () => {
  const nativeDemand = {
    points: [{ id: 'home', location: [-73.8, 42.7] }],
    pops: [{ id: 'pop', residenceId: 'home', jobId: 'home', size: 50 }],
  };
  const imported = [];
  const fetched = [];
  const assetOrigin = 'http://127.0.0.1:58567';
  const adapter = new EmbeddedTilePackageAdapter(PILOT_TILE_IDS, {}, {
    loadCityData: async (path) => {
      imported.push(path);
      throw new TypeError('Failed to fetch dynamically imported module');
    },
    fetchData: async (path) => {
      fetched.push(path);
      return new Response(gzipSync(JSON.stringify(nativeDemand)), { status: 200 });
    },
    resolveDataUrl: (path) => resolveRendererDataUrl(path, {
      locationHref: 'file:///C:/SubwayBuilder/resources/app.asar/dist/renderer.html',
      resourceEntries: [
        { name: 'http://127.0.0.1:8798/NY_CP00_RP02/12/1205/1540.mvt' },
        { name: `${assetOrigin}/data/NY_CP00_RP02/roads.geojson.gz` },
      ],
    }),
  });

  assert.deepEqual(await adapter.loadNativeDemand('NY_CP00_RP02'), nativeDemand);
  assert.deepEqual(fetched, [`${assetOrigin}/data/NY_CP00_RP02/demand_data.json.gz`]);
  assert.deepEqual(imported, []);
});

test('native demand URL resolution falls back to an HTTP renderer origin', () => {
  assert.equal(
    resolveRendererDataUrl('/data/NY_CP00_RP00/demand_data.json.gz', {
      locationHref: 'http://127.0.0.1:58567/game',
      resourceEntries: [],
    }),
    'http://127.0.0.1:58567/data/NY_CP00_RP00/demand_data.json.gz',
  );
});

test('native demand URL resolution never converts a data request to file protocol', () => {
  assert.throws(
    () => resolveRendererDataUrl('/data/NY_CP00_RP00/demand_data.json.gz', {
      locationHref: 'file:///C:/SubwayBuilder/resources/app.asar/dist/renderer.html',
      resourceEntries: [],
    }),
    /Renderer data HTTP origin is unavailable/,
  );
});
