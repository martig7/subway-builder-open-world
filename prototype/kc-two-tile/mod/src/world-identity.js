const ALIAS_PREFIX = 'identity:session:';
const CANONICAL_WORLD_KEY = 'identity:canonical-world';

export class WorldIdentityResolver {
  constructor({
    storage,
    fallbackWorldId = 'kc-two-tile',
    recoveryAliases = {},
    canonicalWorldId = null,
  } = {}) {
    this.storage = storage;
    this.fallbackWorldId = fallbackWorldId;
    this.recoveryAliases = { ...recoveryAliases };
    this.configuredCanonicalWorldId = typeof canonicalWorldId === 'string' && canonicalWorldId
      ? canonicalWorldId
      : null;
    this.canonicalAliases = new Map();
    this.canonicalWorldId = undefined;
  }

  async #readCanonicalWorldId() {
    if (this.canonicalWorldId !== undefined) return this.canonicalWorldId;
    const stored = await this.storage?.get?.(CANONICAL_WORLD_KEY, null);
    if (typeof stored === 'string' && stored) {
      this.canonicalWorldId = stored;
      return stored;
    }
    const worldId = this.configuredCanonicalWorldId;
    if (worldId) await this.#promoteCanonicalWorld(worldId);
    else this.canonicalWorldId = null;
    return this.canonicalWorldId;
  }

  async #promoteCanonicalWorld(worldId) {
    if (typeof worldId !== 'string' || !worldId) return false;
    if (this.canonicalWorldId === worldId) return true;
    await this.storage?.set?.(CANONICAL_WORLD_KEY, worldId);
    const settled = await this.storage?.get?.(CANONICAL_WORLD_KEY, worldId);
    if (settled !== worldId) return false;
    this.canonicalWorldId = worldId;
    return true;
  }

  async #readAlias(sessionId, fallback = null, { refresh = false } = {}) {
    if (!refresh && this.canonicalAliases.has(sessionId)) {
      return this.canonicalAliases.get(sessionId);
    }
    const value = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, fallback);
    if (typeof value === 'string' && value && value !== sessionId) {
      this.canonicalAliases.set(sessionId, value);
    }
    return value;
  }

  #rememberCanonical(sessionId, worldId) {
    if (worldId !== sessionId) this.canonicalAliases.set(sessionId, worldId);
    else this.canonicalAliases.delete(sessionId);
  }

  async resolve(nativeSessionId, pendingWorldId = null, {
    authoritativeWorldId = null,
    ancestorSessionIds = [],
  } = {}) {
    const sessionId = typeof nativeSessionId === 'string' && nativeSessionId
      ? nativeSessionId
      : this.fallbackWorldId;
    if (typeof pendingWorldId === 'string' && pendingWorldId) {
      await this.bind(sessionId, pendingWorldId, { force: true });
      const settled = await this.#readAlias(sessionId, pendingWorldId);
      const worldId = typeof settled === 'string' && settled ? settled : pendingWorldId;
      await this.#promoteCanonicalWorld(worldId);
      return { nativeSessionId: sessionId, worldId, aliased: sessionId !== worldId };
    }
    const alias = await this.#readAlias(sessionId, null);
    const recoveryAlias = this.recoveryAliases[sessionId];
    // Explicit recovery bindings are migrations, not defaults. They must win
    // over a stale alias written by the broken projection lineage and replace
    // it through the authoritative storage API.
    const directlyResolvedWorldId = typeof recoveryAlias === 'string' && recoveryAlias
      ? recoveryAlias
      : typeof alias === 'string' && alias ? alias : sessionId;
    if (directlyResolvedWorldId !== sessionId) {
      if (alias !== directlyResolvedWorldId) {
        await this.bind(sessionId, directlyResolvedWorldId, { force: Boolean(recoveryAlias) });
      }
      const settled = await this.#readAlias(sessionId, directlyResolvedWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : directlyResolvedWorldId;
      if (recoveryAlias) await this.#promoteCanonicalWorld(resolvedWorldId);
      return {
        nativeSessionId: sessionId,
        worldId: resolvedWorldId,
        aliased: resolvedWorldId !== sessionId,
      };
    }

    if (typeof authoritativeWorldId === 'string' && authoritativeWorldId
      && authoritativeWorldId !== sessionId) {
      await this.bind(sessionId, authoritativeWorldId);
      const settled = await this.#readAlias(sessionId, authoritativeWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : authoritativeWorldId;
      await this.#promoteCanonicalWorld(resolvedWorldId);
      return {
        nativeSessionId: sessionId,
        worldId: resolvedWorldId,
        aliased: resolvedWorldId !== sessionId,
        source: 'authoritative-marker',
        sourceSessionId: null,
      };
    }

    const ancestors = [...new Set(ancestorSessionIds)]
      .filter((candidate) => typeof candidate === 'string' && candidate && candidate !== sessionId);
    for (const ancestorSessionId of ancestors) {
      const ancestorAlias = await this.#readAlias(ancestorSessionId, null);
      const ancestorRecoveryAlias = this.recoveryAliases[ancestorSessionId];
      const inheritedWorldId = typeof ancestorRecoveryAlias === 'string' && ancestorRecoveryAlias
        ? ancestorRecoveryAlias
        : typeof ancestorAlias === 'string' && ancestorAlias ? ancestorAlias : null;
      if (!inheritedWorldId || inheritedWorldId === sessionId) continue;
      if (ancestorAlias !== inheritedWorldId) {
        await this.bind(ancestorSessionId, inheritedWorldId, { force: Boolean(ancestorRecoveryAlias) });
      }
      await this.bind(sessionId, inheritedWorldId);
      const settled = await this.#readAlias(sessionId, inheritedWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : inheritedWorldId;
      await this.#promoteCanonicalWorld(resolvedWorldId);
      return {
        nativeSessionId: sessionId,
        worldId: resolvedWorldId,
        aliased: resolvedWorldId !== sessionId,
        source: 'ancestor-session',
        sourceSessionId: ancestorSessionId,
      };
    }

    const canonicalWorldId = await this.#readCanonicalWorldId();
    if (typeof canonicalWorldId === 'string' && canonicalWorldId
      && canonicalWorldId !== sessionId) {
      await this.bind(sessionId, canonicalWorldId);
      const settled = await this.#readAlias(sessionId, canonicalWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : canonicalWorldId;
      return {
        nativeSessionId: sessionId,
        worldId: resolvedWorldId,
        aliased: resolvedWorldId !== sessionId,
        source: 'canonical-world',
        sourceSessionId: null,
      };
    }

    const settled = await this.#readAlias(sessionId, sessionId);
    const resolvedWorldId = typeof settled === 'string' && settled ? settled : sessionId;
    return {
      nativeSessionId: sessionId,
      worldId: resolvedWorldId,
      aliased: resolvedWorldId !== sessionId,
    };
  }

  async bind(nativeSessionId, worldId, { force = false } = {}) {
    if (typeof nativeSessionId !== 'string' || !nativeSessionId
      || typeof worldId !== 'string' || !worldId) return false;
    const key = `${ALIAS_PREFIX}${nativeSessionId}`;
    const existing = !force && this.canonicalAliases.has(nativeSessionId)
      ? this.canonicalAliases.get(nativeSessionId)
      : await this.storage?.get?.(key, null);
    if (existing === worldId) {
      this.#rememberCanonical(nativeSessionId, worldId);
      return true;
    }
    if (!force && typeof existing === 'string' && existing) {
      const existingIsCanonicalAlias = existing !== nativeSessionId;
      const requestedIsSelfWorld = worldId === nativeSessionId;
      // A stale runtime may have resolved the native session before a tile
      // transition attached it to the open-world lineage. Never let its later
      // autosave downgrade that established binding back to the self-world.
      if (existingIsCanonicalAlias && requestedIsSelfWorld) return false;
      // Choosing between two different canonical lineages is only valid for
      // an explicit pending transition or a configured recovery migration.
      if (existingIsCanonicalAlias && existing !== worldId) return false;
    }
    await this.storage?.set?.(key, worldId);
    const settled = await this.storage?.get?.(key, worldId);
    if (settled === worldId) this.#rememberCanonical(nativeSessionId, worldId);
    return settled === worldId;
  }
}

export const WORLD_IDENTITY_ALIAS_PREFIX = ALIAS_PREFIX;
export const WORLD_IDENTITY_CANONICAL_KEY = CANONICAL_WORLD_KEY;

export function worldIdentityLoadOptions(identity, {
  pending = false,
  saveName = null,
  nativeTileId = null,
} = {}) {
  if (pending) return {};
  return {
    ...(typeof saveName === 'string' && saveName ? { saveName } : {}),
    allowLiveFallback: identity?.aliased === true,
    nativeSessionId: identity?.nativeSessionId ?? null,
    nativeTileId,
  };
}
