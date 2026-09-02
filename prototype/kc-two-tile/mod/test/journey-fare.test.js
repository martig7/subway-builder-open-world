import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteJourneyFare } from '../../../../open-world-platform/src/runtime/journey-fare.js';

test('matches native cumulative distance fares, rounding, cap, and route attribution', () => {
  const quote = quoteJourneyFare({
    segments: [
      { routeId: 'west', fromStopCoords: [0, 0], toStopCoords: [0.1, 0] },
      { routeId: 'east', fromStopCoords: [0.1, 0], toStopCoords: [0.2, 0] },
    ],
    fareGroups: [{
      id: 'distance', fareSystem: 'distance', routeIds: ['west', 'east'],
      transferPolicy: 'free-within-group', boardingCharge: 3, perKmRate: 0.15, fareCap: 20,
    }],
    routes: [{ id: 'west', tempParentId: null }, { id: 'east', tempParentId: null }],
    legacyFare: 3,
  });

  assert.equal(quote.total, 6.35);
  assert.deepEqual(quote.revenueByRoute, { west: 4.65, east: 1.7 });
});

test('uses the native public fare total while retaining route-level breakdown', () => {
  const quote = quoteJourneyFare({
    segments: [{ routeId: 'long', fromStopCoords: [0, 0], toStopCoords: [1, 0] }],
    fareGroups: [{
      id: 'distance', fareSystem: 'distance', routeIds: ['long'],
      transferPolicy: 'free-within-group', boardingCharge: 3, perKmRate: 0.15, fareCap: 20,
    }],
    routes: [{ id: 'long', tempParentId: null }],
    legacyFare: 3,
    nativeFare: () => 19.95,
  });

  assert.equal(quote.total, 19.95);
  assert.deepEqual(quote.revenueByRoute, { long: 19.95 });
});
