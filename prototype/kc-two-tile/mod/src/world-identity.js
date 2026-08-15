const ALIAS_PREFIX = 'identity:session:';

export class WorldIdentityResolver {
  constructor({ storage, fallbackWorldId = 'kc-two-tile', recoveryAliases = {} } = {}) {
    this.storage = storage;
    this.fallbackWorldId = fallbackWorldId;
    this.recoveryAliases = { ...recoveryAliases };
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
      const settled = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, pendingWorldId);
      const worldId = typeof settled === 'string' && settled ? settled : pendingWorldId;
      return { nativeSessionId: sessionId, worldId, aliased: sessionId !== worldId };
    }
    const alias = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, null);
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
      const settled = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, directlyResolvedWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : directlyResolvedWorldId;
      return {
        nativeSessionId: sessionId,
        worldId: resolvedWorldId,
        aliased: resolvedWorldId !== sessionId,
      };
    }

    if (typeof authoritativeWorldId === 'string' && authoritativeWorldId
      && authoritativeWorldId !== sessionId) {
      await this.bind(sessionId, authoritativeWorldId);
      const settled = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, authoritativeWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : authoritativeWorldId;
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
      const ancestorAlias = await this.storage?.get?.(`${ALIAS_PREFIX}${ancestorSessionId}`, null);
      const ancestorRecoveryAlias = this.recoveryAliases[ancestorSessionId];
      const inheritedWorldId = typeof ancestorRecoveryAlias === 'string' && ancestorRecoveryAlias
        ? ancestorRecoveryAlias
        : typeof ancestorAlias === 'string' && ancestorAlias ? ancestorAlias : null;
      if (!inheritedWorldId || inheritedWorldId === sessionId) continue;
      if (ancestorAlias !== inheritedWorldId) {
        await this.bind(ancestorSessionId, inheritedWorldId, { force: Boolean(ancestorRecoveryAlias) });
      }
      await this.bind(sessionId, inheritedWorldId);
      const settled = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, inheritedWorldId);
      const resolvedWorldId = typeof settled === 'string' && settled
        ? settled
        : inheritedWorldId;
      return {
        nativeSessionId: sessionId,
        worldId: resolvedWorldId,
        aliased: resolvedWorldId !== sessionId,
        source: 'ancestor-session',
        sourceSessionId: ancestorSessionId,
      };
    }

    const settled = await this.storage?.get?.(`${ALIAS_PREFIX}${sessionId}`, sessionId);
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
    const existing = await this.storage?.get?.(key, null);
    if (existing === worldId) return true;
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
    return settled === worldId;
  }
}

export const WORLD_IDENTITY_ALIAS_PREFIX = ALIAS_PREFIX;

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
