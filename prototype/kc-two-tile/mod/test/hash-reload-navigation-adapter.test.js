import test from 'node:test';
import assert from 'node:assert/strict';
import { findMountedRouter, HashCityNavigationAdapter, PENDING_KEY } from '../../../../open-world-platform/src/runtime/adapters/hash-city-navigation-adapter.js';

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

  navigation.navigateTo({
    worldId: 'world-1',
    tileId: 'KCE',
    from: 'KCW',
    transitionId: 'world-1:KCW->KCE',
  });

  assert.deepEqual(destinations, ['/game?city=KCE']);
  assert.deepEqual(navigation.pending(), {
    worldId: 'world-1', tileId: 'KCE', from: 'KCW', transitionId: 'world-1:KCW->KCE',
  });
  assert.deepEqual(navigation.pendingFor('KCE'), {
    worldId: 'world-1', tileId: 'KCE', from: 'KCW', transitionId: 'world-1:KCW->KCE',
  });
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

test('supports a fresh native-world handoff without inventing a save identity', () => {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const router = { state: { location: { pathname: '/' } }, navigate() {} };
  const navigation = new HashCityNavigationAdapter({ router, sessionStorage, tileIds: ['NY_CP00_RP00'] });

  navigation.navigateTo({ tileId: 'NY_CP00_RP00', freshWorld: true });

  assert.deepEqual(navigation.pending(), { freshWorld: true, tileId: 'NY_CP00_RP00' });
  navigation.complete({ worldId: 'native-session-created-after-reset', tileId: 'NY_CP00_RP00' });
  assert.equal(values.has(PENDING_KEY), false);
});

test('render retirement occurs after navigation validation and pending handoff, before router allocation', () => {
  const calls = [];
  const navigation = new HashCityNavigationAdapter({
    router: { navigate: () => calls.push('navigate') }, tileIds: ['NEXT'],
    sessionStorage: { setItem: () => calls.push('pending') },
  });
  const options = { beforeNavigate: () => calls.push('retire') };
  assert.throws(() => navigation.navigateTo({ worldId: 'world', tileId: 'invalid' }, options));
  assert.deepEqual(calls, []);
  navigation.navigateTo({ worldId: 'world', tileId: 'NEXT' }, options);
  assert.deepEqual(calls, ['pending', 'retire', 'navigate']);
});
