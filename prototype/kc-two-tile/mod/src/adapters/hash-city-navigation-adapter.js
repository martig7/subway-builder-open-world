const PENDING_KEY = 'kc-two-tile:pending-navigation';

function isRouter(value) {
  return Boolean(value && typeof value.navigate === 'function' && value.state?.location);
}

/** Locate the mounted DataRouter without importing the hashed game bundle. */
export function findMountedRouter(document = globalThis.document) {
  const containers = [document?.getElementById?.('root'), document?.body, document?.documentElement].filter(Boolean);
  for (const container of containers) {
    for (const key of Object.keys(container)) {
      if (!key.startsWith('__reactContainer$')) continue;
      const first = container[key]?.current ?? container[key];
      const stack = first ? [first] : [];
      let inspected = 0;
      while (stack.length && inspected++ < 2_000) {
        const fiber = stack.pop();
        for (const props of [fiber?.memoizedProps, fiber?.pendingProps]) {
          if (isRouter(props?.router)) return props.router;
        }
        if (fiber?.sibling) stack.push(fiber.sibling);
        if (fiber?.child) stack.push(fiber.child);
      }
    }
  }
  return null;
}

/** Change the game route without destroying the renderer's mod registrations. */
export class HashCityNavigationAdapter {
  constructor({ router = null, document = globalThis.document, sessionStorage = globalThis.sessionStorage, tileIds = [], pendingKey = PENDING_KEY } = {}) {
    this.router = router;
    this.document = document;
    this.sessionStorage = sessionStorage;
    this.tileIds = [...tileIds];
    this.pendingKey = pendingKey;
  }

  pendingFor(tileId) {
    const pending = this.pending();
    return pending?.tileId === tileId ? pending : null;
  }

  pending() {
    try {
      const pending = JSON.parse(this.sessionStorage?.getItem(this.pendingKey) ?? 'null');
      const hasWorld = typeof pending?.worldId === 'string' && pending.worldId;
      const isFreshWorld = pending?.freshWorld === true;
      return this.tileIds.includes(pending?.tileId) && (hasWorld || isFreshWorld) ? pending : null;
    } catch {
      return null;
    }
  }

  complete(transition) {
    const pending = this.pendingFor(transition.tileId);
    if (pending?.freshWorld === true || pending?.worldId === transition.worldId) {
      this.sessionStorage?.removeItem(this.pendingKey);
    }
  }

  navigateTo({ worldId, tileId, freshWorld = false }) {
    if (!this.tileIds.includes(tileId)) throw new Error('Invalid pending tile navigation');
    if (freshWorld !== true && typeof worldId !== 'string') throw new Error('Invalid pending tile navigation');
    const router = this.router ?? findMountedRouter(this.document);
    if (!router) throw new Error('The mounted Subway Builder router is unavailable');
    this.sessionStorage?.setItem(this.pendingKey, JSON.stringify(
      freshWorld === true ? { freshWorld: true, tileId } : { worldId, tileId },
    ));
    return router.navigate(`/game?city=${tileId}`);
  }
}

export { PENDING_KEY };
