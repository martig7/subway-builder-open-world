import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenWorldCityRegistration } from '../../../../open-world-platform/src/runtime/open-world-city-registration.js';
import { definition, tileCatalog } from '../../../../open-world-platform/testkit/fixtures/kc-world.js';

const { registerPilotCities: registerPrototypeCities } = createOpenWorldCityRegistration({ definition, tileCatalog });


test('both logical cities use definition-derived PMTiles endpoints', () => {
  const cities = [];
  const dataFiles = [];
  const tileOverrides = [];
  const layerVisibility = [];
  const api = {
    registerCity: (city) => cities.push(city),
    utils: { getCities: () => [] },
    cities: { setCityDataFiles: (cityCode, files) => dataFiles.push({ cityCode, files }) },
    map: {
      setTileURLOverride: (override) => tileOverrides.push(override),
      setDefaultLayerVisibility: (cityCode, visibility) => layerVisibility.push({ cityCode, visibility }),
    },
  };

  const result = registerPrototypeCities(api, {
    artifactBase: 'http://artifacts.test',
    tileBase: 'http://tiles.test',
  });

  assert.deepEqual(cities.map(({ code }) => code), ['KCW', 'KCE']);
  assert.ok(cities.every((city) => city.minZoom === 3));
  assert.deepEqual(tileOverrides, [
    { cityCode: 'KCW', tilesUrl: 'http://tiles.test/KCW/{z}/{x}/{y}.mvt?v=kcow-fixture-v1', maxZoom: 15 },
    { cityCode: 'KCE', tilesUrl: 'http://tiles.test/KCE/{z}/{x}/{y}.mvt?v=kcow-fixture-v1', maxZoom: 15 },
  ]);
  assert.equal(result.tileBase, 'http://tiles.test');
  assert.equal(dataFiles[0].files.buildingsIndex, '/data/KCW/buildings_index.bin.gz');
  assert.equal(dataFiles[1].files.buildingsIndex, '/data/KCE/buildings_index.bin.gz');
  assert.deepEqual(layerVisibility.map(({ cityCode }) => cityCode), ['KCW', 'KCE']);
});

test('registered game data files survive the installed game data-server URL resolver', () => {
  const dataFiles = [];
  const api = {
    registerCity: () => {},
    utils: { getCities: () => [] },
    cities: { setCityDataFiles: (cityCode, files) => dataFiles.push({ cityCode, files }) },
    map: {
      setTileURLOverride: () => {},
      setDefaultLayerVisibility: () => {},
    },
  };
  registerPrototypeCities(api, { artifactBase: 'http://127.0.0.1:8787' });

  for (const { files } of dataFiles) {
    for (const path of Object.values(files)) {
      const request = `http://127.0.0.1:57992${path}?useDownloaded=true`;
      assert.doesNotThrow(() => new URL(request), request);
      assert.equal(new URL(request).origin, 'http://127.0.0.1:57992');
    }
  }
});

test('registration fails clearly when the tile override API is unavailable', () => {
  assert.throws(
    () => registerPrototypeCities({ map: {} }),
    /map\.setTileURLOverride is unavailable/,
  );
});
