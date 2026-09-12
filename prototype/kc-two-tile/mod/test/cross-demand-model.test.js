import test from 'node:test';
import assert from 'node:assert/strict';
import { CrossDemandModel, demandPointRadius, modeShareColor } from '../../../../open-world-platform/src/runtime/cross-demand-model.js';

const data = {
  schemaVersion: 1,
  gateways: ['central'],
  points: [
    ['home', -94.7, 39.1, 'KCW', 10, 0],
    ['work-a', -94.5, 39.1, 'KCE', 0, 6],
    ['work-b', -94.4, 39.0, 'KCE', 0, 4],
  ],
  pops: [
    ['pop-a', 6, 0, 1, 0],
    ['pop-b', 4, 0, 2, 0],
  ],
};
const ledger = {
  flow: {
    flow: { homeTileId: 'KCW', workTileId: 'KCE', gatewayId: 'central', mass: 10 },
    modeChoice: { driving: 2, walking: 3, transit: 5 },
  },
};

test('decodes compact cross demand and builds resident/worker projections', () => {
  const model = new CrossDemandModel(data, ledger);
  assert.deepEqual(model.stats, { points: 3, pops: 2, population: 10, oneWayMovements: 0 });
  assert.equal(model.pointFeatures('residents').features.length, 1);
  assert.equal(model.pointFeatures('workers').features.length, 2);
  assert.equal(model.pointDetails('home', 'residents').popCount, 2);
  assert.equal(model.connections('home', 'residents').features.length, 4);
  assert.equal(model.popSelection(0).features[0].geometry.type, 'LineString');
});

test('per-point projections hide unrelated demand points and expose every unique endpoint', () => {
  const model = new CrossDemandModel(data, ledger);

  assert.deepEqual(model.pointFeatures('workers', 'work-a').features.map((feature) => feature.properties.id), ['work-a']);
  const features = model.connections('home', 'residents').features;
  assert.equal(features.filter((feature) => feature.properties.kind === 'connection').length, 2);
  assert.deepEqual(
    features.filter((feature) => feature.properties.view === 'per-point-endpoint')
      .map((feature) => [feature.properties.id, feature.properties.kind, feature.properties.mass]),
    [['work-a', 'work', 6], ['work-b', 'work', 4]],
  );
});

test('matches the native area-proportional demand bubble sizing and mode-share RGB mixing', () => {
  const resident50 = Math.sqrt(50 / Math.PI) * 6.5;
  const resident600 = Math.sqrt(600 / Math.PI) * 6.5;
  const worker600 = Math.sqrt(600 / Math.PI) * 2.5;

  assert.ok(Math.abs(demandPointRadius(50, 'residents') - resident50) < 1e-9);
  assert.ok(Math.abs(demandPointRadius(600, 'residents') - resident600) < 1e-9);
  assert.ok(Math.abs(demandPointRadius(600, 'workers') - worker600) < 1e-9);
  assert.ok(demandPointRadius(600, 'residents') / demandPointRadius(50, 'residents') > 3.4);
  assert.equal(modeShareColor({ driving: 2, walking: 3, transit: 5 }), '#334d80');
  assert.equal(modeShareColor({ driving: 0, walking: 0, transit: 0 }), '#646464');
});

test('sizes displayed resident and worker points with their native curves', () => {
  const model = new CrossDemandModel(data, ledger);
  const resident = model.pointFeatures('residents').features[0];
  const worker = model.pointFeatures('workers').features[0];

  assert.ok(Math.abs(resident.properties.baseRadius - Math.sqrt(10 / Math.PI) * 6.5) < 1e-9);
  assert.ok(Math.abs(worker.properties.baseRadius - Math.sqrt(6 / Math.PI) * 2.5) < 1e-9);
});

test('densifies long O/D lines as native great-circle arcs that terminate on their endpoints', () => {
  const longDistance = {
    schemaVersion: 1,
    gateways: ['continental'],
    points: [
      ['new-york', -74.006, 40.7128, 'NY', 100, 0],
      ['los-angeles', -118.2437, 34.0522, 'CA', 0, 100],
    ],
    pops: [['coast-to-coast', 100, 0, 1, 0]],
  };
  const model = new CrossDemandModel(longDistance);

  for (const feature of [
    model.connections('new-york', 'residents').features[0],
    model.popSelection(0).features[0],
  ]) {
    const coordinates = feature.geometry.coordinates;
    assert.equal(coordinates.length, 13);
    assert.deepEqual(coordinates[0], longDistance.points[0].slice(1, 3));
    assert.deepEqual(coordinates.at(-1), longDistance.points[1].slice(1, 3));
    assert.ok(coordinates[6][1] > 39, 'great-circle midpoint should bow north of the Mercator chord');
  }
});

test('uses each pop mode choice instead of painting every pop with its gateway bucket average', () => {
  const popModeChoices = {
    'pop-a': { driving: 0, walking: 0, transit: 6, unknown: 0 },
    'pop-b': { driving: 2, walking: 2, transit: 0, unknown: 0 },
  };
  const model = new CrossDemandModel(data, ledger, popModeChoices);

  assert.deepEqual(model.popDetails(0).modeChoice, { driving: 0, walking: 0, transit: 6 });
  assert.deepEqual(model.popDetails(1).modeChoice, { driving: 2, walking: 2, transit: 0 });
  assert.deepEqual(model.pointDetails('home', 'residents').modeChoice, {
    driving: 2,
    walking: 2,
    transit: 6,
  });
  assert.equal(model.pointFeatures('residents').features[0].properties.color, '#333399');
});
