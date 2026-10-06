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
  assert.deepEqual(model.stats, { points: 3, pops: 2, population: 10, oneWayMovements: 0,
    inducedPopulation: 0, inducedPops: 0, inducedPoints: 0 });
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

function mixedInducedModel() {
  const raw = {
    schemaVersion: 1,
    gateways: ['central'],
    points: [
      ['shared-home', -94.7, 39.1, 'KCW', 107, 2],
      ['shared-work', -94.5, 39.1, 'KCE', 0, 110],
      ['other-home', -94.6, 39.2, 'KCW', 5, 0],
      ['movement-end', -94.4, 39.0, 'KCE', 0, 0],
    ],
    pops: [
      ['induced-looking-packaged-id', 100, 0, 1, 0],
      ['extension-cohort-a', 7, 0, 1, 0],
      ['extension-cohort-b', 3, 2, 1, 0],
      ['extension-cohort-c', 2, 2, 0, 0],
      ['marked-one-way', 50, 0, 3, 0, 8, null, 60, 1000, 'oneWay'],
    ],
    extensionPopIds: ['extension-cohort-a', 'extension-cohort-b', 'extension-cohort-c', 'marked-one-way'],
  };
  const choices = {
    'induced-looking-packaged-id': { driving: 100, walking: 0, transit: 0 },
    'extension-cohort-a': { driving: 0, walking: 0, transit: 7 },
    'extension-cohort-b': { driving: 0, walking: 3, transit: 0 },
    'extension-cohort-c': { driving: 2, walking: 0, transit: 0 },
    'marked-one-way': { driving: 50, walking: 0, transit: 0 },
  };
  return { model: new CrossDemandModel(raw, {}, choices), raw };
}

test('induced views isolate marked commute mass at shared endpoints and preserve the ordinary views', () => {
  const { model } = mixedInducedModel();
  assert.equal(model.stats.population, 112);
  assert.equal(model.stats.oneWayMovements, 50);
  assert.equal(model.stats.inducedPopulation, 12);
  assert.equal(model.stats.inducedPops, 3);
  assert.equal(model.stats.inducedPoints, 3);
  assert.deepEqual(model.pointFeatures('inducedResidents').features.map(feature => [feature.properties.id, feature.properties.population]),
    [['shared-home', 7], ['other-home', 5]]);
  assert.deepEqual(model.pointFeatures('inducedWorkers').features.map(feature => [feature.properties.id, feature.properties.population]),
    [['shared-home', 2], ['shared-work', 10]]);
  assert.equal(model.pointDetails('shared-home', 'residents').population, 107);
  assert.equal(model.pointDetails('shared-work', 'workers').population, 110);
  assert.equal(model.pointDetails('shared-home', 'outboundMovements').population, 50);
});

test('induced details, mode filters, radius and direction include only induced commutes', () => {
  const { model } = mixedInducedModel();
  const details = model.pointDetails('shared-work', 'inducedWorkers');
  assert.equal(details.population, 10);
  assert.equal(details.popCount, 2);
  assert.deepEqual(details.pops.map(pop => pop.id), ['extension-cohort-a', 'extension-cohort-b']);
  assert.deepEqual(details.modeChoice, { driving: 0, walking: 3, transit: 7 });
  assert.deepEqual(model.pointDetails('shared-work', 'inducedWorkers', 1, 1).pops.map(pop => pop.id), ['extension-cohort-b']);
  assert.deepEqual(model.pointFeatures('inducedResidents', null, 'driving').features.map(feature => [feature.properties.id, feature.properties.population]),
    [['other-home', 2]]);
  assert.deepEqual(model.pointFeatures('inducedResidents', 'shared-home').features.map(feature => feature.properties.color), ['#0000ff']);
  const workerDot = model.pointFeatures('inducedWorkers', 'shared-work', 'transit').features[0];
  assert.equal(workerDot.properties.population, 7);
  assert.equal(workerDot.properties.color, '#0000ff');
  assert.equal(workerDot.properties.baseRadius, 80);
  assert.equal(demandPointRadius(10, 'inducedWorkers'), demandPointRadius(10, 'workers'));
  assert.equal(demandPointRadius(10, 'inducedResidents'), demandPointRadius(10, 'residents'));
  assert.deepEqual(model.connections('shared-work', 'inducedWorkers').features.filter(feature => feature.properties.view === 'per-point-endpoint')
    .map(feature => [feature.properties.id, feature.properties.kind, feature.properties.mass]),
    [['shared-home', 'home', 7], ['other-home', 'home', 3]]);
  assert.deepEqual(model.connections('shared-home', 'inducedResidents').features.filter(feature => feature.properties.view === 'per-point-endpoint')
    .map(feature => [feature.properties.id, feature.properties.kind, feature.properties.mass]),
    [['shared-work', 'work', 7]]);
});

test('induced global summaries and cached point summaries do not rescan commutes when switching views', () => {
  const { model, raw } = mixedInducedModel();
  const expected = { population: 12, pops: 3, modeChoice: { driving: 2, walking: 3, transit: 7 } };
  assert.deepEqual(model.summary('inducedResidents'), expected);
  assert.deepEqual(model.summary('inducedWorkers'), expected);
  assert.deepEqual(model.summary('inducedResidents', 'shared-home'), { population: 7, pops: 1,
    modeChoice: { driving: 0, walking: 0, transit: 7 } });
  const cached = model.summary('inducedWorkers', 'shared-work');
  raw.pops.forEach = () => { throw new Error('commute index must be prepared only once'); };
  raw.pops[Symbol.iterator] = () => { throw new Error('no whole-catalog scan while switching views'); };
  assert.equal(model.summary('inducedWorkers', 'shared-work'), cached);
  for (let index = 0; index < 20; index++) {
    assert.equal(model.pointFeatures(index % 2 ? 'inducedWorkers' : 'inducedResidents').features.length, 2);
    assert.deepEqual(model.summary('inducedWorkers'), expected);
  }
});

test('unmarked and empty induced subsets have no dots, connections or demand summary', () => {
  const model = new CrossDemandModel(data, ledger);
  for (const view of ['inducedResidents', 'inducedWorkers']) {
    assert.deepEqual(model.pointFeatures(view).features, []);
    assert.deepEqual(model.connections('home', view).features, []);
    assert.equal(model.pointDetails('home', view).popCount, 0);
    assert.deepEqual(model.summary(view), { population: 0, pops: 0, modeChoice: { driving: 0, walking: 0, transit: 0 } });
  }
  assert.equal(model.stats.inducedPopulation, 0);
  assert.equal(model.stats.inducedPoints, 0);
});
