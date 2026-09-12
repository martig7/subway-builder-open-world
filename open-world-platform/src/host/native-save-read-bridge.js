/** Installed in the host's isolated preload, before its existing API is exposed.
 * Keep this function self-contained: the opt-in installer embeds its source.
 * No IPC channels or filesystem access are added. */
export function installNativeSaveReadBridge(contextBridge) {
  if (typeof contextBridge?.executeInMainWorld !== 'function'
    || typeof contextBridge?.exposeInMainWorld !== 'function') return false;
  const version = 'native-save-read-json-v1';
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
    const api = {
      ...wire,
      async getPendingSave(...args) {
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
    const stats = { version, jsonReads: 0, nativeReads: 0, infoReads: 0,
      lastBytes: 0, lastEncodeMilliseconds: 0 };
    const wire = {
      ...api,
      async getPendingSave(...args) {
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
    expose.call(contextBridge, wireName, wire);
    return contextBridge.executeInMainWorld({ func: publishNativeApi, args: [apiKey, wireName, version] });
  };
  return true;
}
