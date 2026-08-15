import test from 'node:test';
import assert from 'node:assert/strict';
import { findMountedRouter, HashCityNavigationAdapter, PENDING_KEY } from '../src/adapters/hash-city-navigation-adapter.js';

test('persists the world handoff and changes city through the mounted data router', () => {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const destinations = [];
  const router = { state: { location: { pathname: '/game' } }, navigate: (to) => destinations.push(to) };
  const navigation = new HashCityNavigationAdapter({ router, sessionStorage, tileIds: ['KCW', 'KCE'] });

  navigation.navigateTo({ worldId: 'world-1', tileId: 'KCE' });

  assert.deepEqual(destinations, ['/game?city=KCE']);
  assert.deepEqual(navigation.pending(), { worldId: 'world-1', tileId: 'KCE' });
  assert.deepEqual(navigation.pendingFor('KCE'), { worldId: 'world-1', tileId: 'KCE' });
  navigation.complete({ worldId: 'world-1', tileId: 'KCE' });
  assert.equal(values.has(PENDING_KEY), false);
});

test('discovers the router near the top of the mounted React fiber tree', () => {
  const router = { state: { location: { pathname: '/game' } }, navigate() {} };
  const fiber = { child: { memoizedProps: { router } } };
  const root = { '__reactContainer$fixture': fiber };
  const document = { getElementById: () => root, body: null, documentElement: null };

  assert.equal(findMountedRouter(document), router);
});
