import test from 'node:test';
import assert from 'node:assert/strict';
import { startOpenWorld } from '../../../../open-world-platform/src/runtime/start-open-world.js';
import definition from '../../../../worlds/japan/world.json' with { type: 'json' };
import catalogSource from '../../../../worlds/japan/geography/tile-views.json' with { type: 'json' };

test('Japan registers train choices before a city or native save has loaded', () => {
  const trainTypes = {}, cities = [];
  const api = {
    trains: { registerTrainType(type) { trainTypes[type.id] = type; } },
    registerCity(city) { cities.push(city); },
    cities: { setCityDataFiles() {} },
    utils: { getCities: () => cities, getCityCode: () => null },
    map: { setTileURLOverride() {}, setDefaultLayerVisibility() {} },
    hooks: {},
  };
  const controller = startOpenWorld({ definition, catalogSource, subwayBuilderHost: api,
    artifacts: { commuteCatalog: { buckets: [] }, crossDemandGzipBase64: 'unused-while-dormant' } });
  try {
    assert.equal(controller.status, 'dormant');
    assert.equal(controller.definition.identity.manifestId, 'local.japan-open-world');
    assert.equal(controller.intercityTrains.status, 'registered');
    assert.deepEqual(Object.keys(trainTypes), ['open-world-high-speed', 'open-world-maglev']);
  } finally { controller.dispose(); }
});
