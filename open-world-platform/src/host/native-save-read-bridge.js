/** Installed in the host's isolated preload, before its existing API is exposed.
 * Keep this function self-contained: the opt-in installer embeds its source.
 * No IPC channels or filesystem access are added. */
export function installNativeSaveReadBridge(contextBridge) {
  if (typeof contextBridge?.executeInMainWorld !== 'function'
    || typeof contextBridge?.exposeInMainWorld !== 'function') return false;
  const version = 'native-save-read-json-v2';
  const expose = contextBridge.exposeInMainWorld;
  const wireName = '__openWorldNativeSaveReadWireV1__';

  function inspectJsonTree(root) {
    const seen = new WeakSet(), special = [];
    const record = (parent, key, kind) => {
      const path = key === null ? [] : [key];
      for (let node = parent; node && node.key !== null; node = node.parent) path.push(node.key);
      special.push({ path: path.reverse(), kind });
    };
    function visit(value, parent, key) {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
      if (value === undefined) { record(parent, key, 'undefined'); return true; }
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
          record(parent, key, Object.is(value, -0) ? '-0' : String(value));
        }
        return true;
      }
      if (typeof value !== 'object' || seen.has(value)) return false;
      const array = Array.isArray(value);
      if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)
        || Object.getOwnPropertySymbols(value).length || 'toJSON' in value) return false;
      seen.add(value);
      const node = { parent, key };
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (array) {
        // Sparse slots, getters and non-JSON types must keep the native path.
        for (let i = 0; i < value.length; i++) {
          const descriptor = descriptors[i];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
          if (!visit(descriptor.value, node, i)) return false;
        }
      } else {
        for (const [name, descriptor] of Object.entries(descriptors)) {
          if (!descriptor.enumerable) continue;
          if (!Object.hasOwn(descriptor, 'value')) return false;
          if (!visit(descriptor.value, node, name)) return false;
        }
      }
      return true;
    }
    return visit(root, null, null) ? special : null;
  }

  function publishNativeApi(apiKey, transportKey, bridgeVersion) {
    // Electron serializes this function into the main world without closures.
    const wire = globalThis[transportKey];
    const parse = JSON.parse;
    const localVersion = 'renderer-local-native-handoff-v1';
    const messageType = '__openWorldLocalHandoffBackupV1__';
    const timeoutMs = 60_000;
    let local = null;
    let cleanup = Promise.resolve();
    let cleanupOwner = null;
    const localStats = { staged: 0, consumed: 0, cancelled: 0, failed: 0 };
    const failure = (error, code = 'local-handoff-failed') => ({ success: false, error, code });
    const supported = typeof wire.__openWorldBeginLocalHandoff === 'function'
      && typeof globalThis.postMessage === 'function' && typeof globalThis.MessageChannel === 'function'
      && typeof globalThis.addEventListener === 'function';
    function currentCity() {
      const location = globalThis.location;
      const route = location?.hash?.startsWith('#/') ? location.hash.slice(1)
        : `${location?.pathname ?? ''}${location?.search ?? ''}`;
      const [pathname, search = ''] = route.split('?');
      const city = pathname === '/game' ? new URLSearchParams(search).get('city') : null;
      // The release loader may qualify the route as "manifest-id:tile-id" while
      // native saves and World transitions retain the bare tile city code.
      return city == null ? null : city.slice(city.lastIndexOf(':') + 1);
    }
    function identity(save) {
      const marker = save?.metadata?.openWorldNativeRecovery;
      const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
      if (marker?.schemaVersion !== 1 || marker.reason !== 'tile-navigation'
        || ![marker.recoveryId, marker.transitionId, marker.sourceCityCode, marker.destinationCityCode,
          save?.gameSessionId].every(text)
        || marker.sourceCityCode === marker.destinationCityCode || save.cityCode !== marker.destinationCityCode
        || (save.cityUid != null && save.cityUid !== marker.destinationCityCode)
        || !['routes', 'tracks', 'trains'].every(key => Array.isArray(save.data?.[key]))) return null;
      return { recoveryId: marker.recoveryId, transitionId: marker.transitionId,
        sourceCityCode: marker.sourceCityCode, destinationCityCode: marker.destinationCityCode,
        gameSessionId: save.gameSessionId };
    }
    function info(save) {
      const value = {};
      for (const key of ['id', 'path', 'name', 'timestamp', 'gameSessionId', 'cityCode']) {
        if (Object.hasOwn(save, key)) value[key] = save[key];
      }
      const marker = save.metadata.openWorldNativeRecovery, compactMarker = {};
      for (const key of ['schemaVersion', 'reason', 'recoveryId', 'transitionId', 'sourceCityCode', 'destinationCityCode', 'stagedAt']) {
        if (Object.hasOwn(marker, key)) compactMarker[key] = marker[key];
      }
      value.metadata = { openWorldNativeRecovery: compactMarker };
      return value;
    }
    function drop(owner, result = failure('Local handoff was superseded', 'cancelled')) {
      if (local !== owner) return false;
      local = null;
      owner.save = null;
      owner.abort?.(result);
      return true;
    }
    function cleanBackup(owner) {
      const recoveryId = owner.identity.recoveryId;
      const record = { identity: owner.identity, permit: owner.permit, state: 'pending' };
      cleanupOwner = record;
      // Begin may still be crossing contextBridge. Its eventual epoch remains
      // necessary to cancel an already delivered native backup, never a newer save.
      cleanup = (async () => {
        const permit = await owner.permit;
        if (!permit?.success) return { success: true, cancelled: true };
        const result = await wire.__openWorldCancelLocalHandoffBackup(permit.epoch, recoveryId);
        return { ...result, cancelled: true };
      })().catch(error => failure(String(error?.message ?? error), 'backup-cancel-failed')).then(result => {
        record.state = result?.success === false ? 'failed' : 'done';
        return result;
      });
      return cleanup;
    }
    function cancel(recoveryId) {
      const owner = local;
      if (!owner || owner.identity.recoveryId !== recoveryId) return cleanupOwner?.identity.recoveryId === recoveryId
        ? (cleanupOwner.state === 'failed' ? cleanBackup(cleanupOwner) : cleanup)
        : Promise.resolve({ success: true, cancelled: false });
      drop(owner);
      localStats.cancelled++;
      return cleanBackup(owner);
    }
    async function stage(save) {
      const meta = identity(save);
      if (!meta || currentCity() !== meta.sourceCityCode) return failure('Invalid local tile handoff', 'invalid-handoff');
      if (local) return failure('A local tile handoff is already pending', 'handoff-busy');
      if (cleanupOwner && cleanupOwner.state !== 'done') return failure('Previous native handoff cleanup must complete before staging another save',
        cleanupOwner.state === 'failed' ? 'backup-cancel-failed' : 'handoff-busy');
      const owner = { save, identity: meta, info: info(save), state: 'staging', abort: null, permit: null };
      save = null;
      local = owner;
      try {
        owner.permit = Promise.resolve(wire.__openWorldBeginLocalHandoff(meta));
        const permit = await owner.permit;
        if (!permit?.success) { drop(owner); return permit; }
        if (local !== owner) return failure('Local handoff was cancelled', 'cancelled');
        const result = await new Promise(resolve => {
          const channel = new globalThis.MessageChannel();
          let finished = false;
          const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            channel.port1.onmessage = null;
            channel.port1.close();
            owner.abort = null;
            resolve(result);
          };
          const timer = setTimeout(() => finish(failure('Native handoff backup acknowledgement timed out', 'backup-timeout')), timeoutMs);
          owner.abort = finish;
          channel.port1.onmessage = event => {
            const result = event.data;
            if (result?.epoch === permit.epoch && result?.recoveryId === meta.recoveryId) finish(result);
          };
          channel.port1.start?.();
          try {
            globalThis.postMessage({ type: messageType, epoch: permit.epoch, save: owner.save }, '*', [channel.port2]);
          } catch (error) {
            channel.port2.close();
            finish(failure(String(error?.message ?? error), 'backup-post-failed'));
          }
        });
        if (local !== owner) return failure('Local handoff was superseded', 'cancelled');
        if (!result?.success) {
          drop(owner);
          localStats.failed++;
          // This conditional operation also revokes a delayed postMessage.
          // Never retry the full graph through the slower bridge after failure.
          cleanBackup(owner);
          return result;
        }
        owner.state = 'ready';
        // A completed older cleanup no longer owns this acknowledged stage.
        cleanupOwner = null;
        cleanup = Promise.resolve();
        localStats.staged++;
        return { success: true, recoveryId: meta.recoveryId, transport: 'renderer-local' };
      } catch (error) {
        if (drop(owner) && owner.permit) cleanBackup(owner);
        localStats.failed++;
        return failure(String(error?.message ?? error));
      }
    }
    const api = {
      ...wire,
      async getPendingSave(...args) {
        const cleared = await cleanup;
        if (cleared?.success === false) return cleared;
        if (local) {
          if (currentCity() !== local.identity.destinationCityCode) return failure('Local handoff belongs to a different destination', 'wrong-destination');
          if (local.state === 'staging') return failure('Native handoff backup is not ready', 'backup-pending');
          const save = local.save;
          // A second native loader must not re-read the backup while the first
          // loader is between getPendingSave and removePendingSave.
          local.save = null;
          local.state = 'consumed';
          if (save) localStats.consumed++;
          return { success: true, data: save };
        }
        const result = await wire.getPendingSave(...args);
        if (result.format !== 'json') return result.value;
        let value = parse(result.text);
        for (const { path, kind } of result.special) {
          const restored = kind === 'undefined' ? undefined : kind === '-0' ? -0 : Number(kind);
          if (!path.length) { value = restored; continue; }
          let owner = value;
          for (const key of path.slice(0, -1)) owner = owner[key];
          Object.defineProperty(owner, path.at(-1), {
            value: restored, writable: true, configurable: true, enumerable: true,
          });
        }
        return value;
      },
      __openWorldNativeSaveReadVersion: bridgeVersion,
    };
    if (supported) {
      for (const name of ['setPendingSave', 'loadAndSetPendingSave', 'removePendingSave', 'clearPendingSave']) {
        if (typeof wire[name] !== 'function') continue;
        api[name] = (...args) => {
          if (local) drop(local);
          cleanupOwner = null;
          cleanup = Promise.resolve();
          return wire[name](...args);
        };
      }
      api.__openWorldGetPendingSaveInfo = async (...args) => {
        const cleared = await cleanup;
        if (cleared?.success === false) return cleared;
        return local ? { success: true, data: local.info } : wire.__openWorldGetPendingSaveInfo(...args);
      };
      api.__openWorldStageLocalHandoff = stage;
      api.__openWorldCancelLocalHandoff = cancel;
      api.__openWorldLocalHandoffVersion = localVersion;
      api.__openWorldLocalHandoffStats = () => ({ version: localVersion, ...localStats,
        retainedPayloads: local?.save ? 1 : 0, state: local?.state ?? 'empty', recoveryId: local?.identity.recoveryId ?? null });
      const routeChanged = () => {
        if (!local) return;
        const city = currentCity();
        if (city === local.identity.destinationCityCode) local.destinationEntered = true;
        else if (city !== local.identity.sourceCityCode || local.destinationEntered) {
          void cancel(local.identity.recoveryId).catch(() => {});
        }
      };
      globalThis.addEventListener('hashchange', routeChanged);
      globalThis.addEventListener('popstate', routeChanged);
    }
    Object.defineProperty(globalThis, apiKey, {
      value: Object.freeze(api), enumerable: true, configurable: false, writable: false,
    });
  }

  contextBridge.exposeInMainWorld = function exposeWithNativeSaveRead(apiKey, api) {
    if (apiKey !== 'electron' || typeof api?.getPendingSave !== 'function') {
      return expose.call(contextBridge, apiKey, api);
    }
    contextBridge.exposeInMainWorld = expose;
    const read = api.getPendingSave;
    let epoch = 0, permitted = null, backupOwner = null, nativeMutations = 0;
    let mutationTail = Promise.resolve();
    const enqueue = operation => {
      const result = mutationTail.then(operation);
      mutationTail = result.catch(() => {});
      return result;
    };
    const stats = { version, jsonReads: 0, nativeReads: 0, infoReads: 0,
      lastBytes: 0, lastEncodeMilliseconds: 0 };
    const wire = {
      ...api,
      async getPendingSave(...args) {
        await mutationTail;
        const result = await read.apply(api, args);
        const started = performance.now();
        let text, special;
        try {
          special = inspectJsonTree(result);
          if (special) text = JSON.stringify(result) ?? 'null';
        } catch { /* Native fallback below. */ }
        if (typeof text !== 'string') { stats.nativeReads++; return { format: 'native', value: result }; }
        stats.jsonReads++;
        stats.lastBytes = text.length;
        stats.lastEncodeMilliseconds = performance.now() - started;
        return { format: 'json', text, special };
      },
      async __openWorldGetPendingSaveInfo() {
        await mutationTail;
        const result = await read.call(api);
        stats.infoReads++;
        if (result?.success === false) return { success: false, error: result.error };
        const save = result?.save ?? result?.data;
        if (!save) return { success: true, data: null };
        const info = {};
        for (const key of ['id', 'path', 'name', 'timestamp', 'gameSessionId', 'cityCode']) {
          if (Object.hasOwn(save, key)) info[key] = save[key];
        }
        const marker = save.metadata?.openWorldNativeRecovery;
        if (marker) info.metadata = { openWorldNativeRecovery: marker };
        return { success: true, data: info };
      },
      __openWorldNativeSaveReadStats: () => ({ ...stats }),
    };
    if (typeof globalThis.addEventListener === 'function' && typeof globalThis.postMessage === 'function'
      && typeof api.setPendingSave === 'function' && typeof api.removePendingSave === 'function') {
      const same = (a, b) => a && b && ['recoveryId', 'transitionId', 'sourceCityCode', 'destinationCityCode', 'gameSessionId']
        .every(key => a[key] === b[key]);
      wire.__openWorldBeginLocalHandoff = identity => {
        if (nativeMutations || permitted) return { success: false, error: 'Native pending-save mutation is in flight', code: 'handoff-busy' };
        const selectedEpoch = ++epoch;
        permitted = { ...identity, epoch: selectedEpoch };
        return { success: true, epoch: selectedEpoch };
      };
      wire.__openWorldCancelLocalHandoffBackup = (selectedEpoch, recoveryId) => {
        if (permitted?.epoch === selectedEpoch && permitted.recoveryId === recoveryId) { permitted = null; ++epoch; }
        return enqueue(async () => {
          if (backupOwner?.epoch !== selectedEpoch || backupOwner.recoveryId !== recoveryId) return { success: true, cancelled: false };
          const result = await api.removePendingSave();
          if (result?.success === false) return { success: false, error: result.error ?? 'Could not cancel native handoff backup' };
          backupOwner = null;
          return { success: true, cancelled: true };
        });
      };
      for (const name of ['setPendingSave', 'loadAndSetPendingSave', 'removePendingSave', 'clearPendingSave']) {
        if (typeof api[name] !== 'function') continue;
        wire[name] = (...args) => {
          ++epoch;
          permitted = null;
          nativeMutations++;
          return enqueue(async () => {
            backupOwner = null;
            try { return await api[name](...args); }
            finally { nativeMutations--; }
          });
        };
      }
      globalThis.addEventListener('message', event => {
        if (event.source !== globalThis.window || event.data?.type !== '__openWorldLocalHandoffBackupV1__') return;
        const port = event.ports?.[0];
        if (!port) return;
        let payload = event.data.save;
        // This envelope is our structured clone, not the sender's save. Drop
        // its duplicate root before an asynchronous backup/ack can retain it.
        event.data.save = null;
        const marker = payload?.metadata?.openWorldNativeRecovery;
        const selectedEpoch = event.data.epoch, recoveryId = marker?.recoveryId;
        const meta = marker && { ...marker, gameSessionId: payload?.gameSessionId };
        const valid = permitted?.epoch === selectedEpoch && epoch === selectedEpoch && same(permitted, meta)
          && marker?.schemaVersion === 1 && marker.reason === 'tile-navigation'
          && payload?.cityCode === marker.destinationCityCode
          && ['routes', 'tracks', 'trains'].every(key => Array.isArray(payload?.data?.[key]));
        const timer = setTimeout(() => port.close(), 60_000);
        const reply = result => {
          clearTimeout(timer);
          try { port.postMessage({ ...result, epoch: selectedEpoch, recoveryId }); } catch { /* Sender timed out or cancelled. */ }
          finally { port.close(); }
        };
        if (!valid) { payload = null; reply({ success: false, error: 'Local handoff permission expired', code: 'cancelled' }); return; }
        // Only a matching, one-use permit may enqueue a graph. The permit stays
        // occupied through acknowledgement; ordinary native mutations revoke it.
        if (permitted.delivered) { payload = null; reply({ success: false, error: 'Local handoff already delivered', code: 'cancelled' }); return; }
        permitted.delivered = true;
        nativeMutations++;
        void enqueue(async () => {
          if (epoch !== selectedEpoch || permitted?.epoch !== selectedEpoch) {
            payload = null;
            return { success: false, error: 'Local handoff was superseded', code: 'cancelled' };
          }
          const resultPromise = api.setPendingSave(payload);
          payload = null;
          const result = await resultPromise;
          if (result?.success !== true) return { success: false, error: result?.error ?? 'Native handoff backup did not confirm success', code: 'backup-failed' };
          backupOwner = { epoch: selectedEpoch, recoveryId };
          return epoch === selectedEpoch ? { success: true }
            : { success: false, error: 'Local handoff was superseded', code: 'cancelled' };
        }).finally(() => { nativeMutations--; }).then(reply, error => {
          payload = null;
          reply({ success: false, error: String(error?.message ?? error), code: 'backup-failed' });
        });
      });
    }
    expose.call(contextBridge, wireName, wire);
    return contextBridge.executeInMainWorld({ func: publishNativeApi, args: [apiKey, wireName, version] });
  };
  return true;
}
