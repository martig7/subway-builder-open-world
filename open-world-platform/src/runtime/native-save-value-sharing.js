const MAX_ENTRIES = 50000;
const MAX_NODES = 1000000;

/** Intern small, equal JSON containers within one outgoing Native Save field.
 * Numeric hash buckets avoid retaining another serialized copy of the save.
 * Every hash match is checked against the actual keys and values. Limits cap
 * scratch storage; unfamiliar objects retain their original native behavior. */
export function shareNativeSaveValueReferences(value, {
  maxEntries = MAX_ENTRIES, maxNodes = MAX_NODES, onStats = null,
} = {}) {
  const cache = new Map(), seen = new WeakMap(), identities = new WeakMap(), active = new WeakSet();
  const cycle = {};
  let entries = 0, hits = 0, visited = 0, sequence = 0;
  const entryLimit = Math.max(0, Math.min(MAX_ENTRIES, Number(maxEntries) || 0));
  const nodeLimit = Math.max(0, Math.min(MAX_NODES, Number(maxNodes) || 0));
  const textHash = (text, hash = 2166136261) => {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return hash | 0;
  };
  const scalarHash = item => {
    if (item === null) return 1234;
    const type = typeof item;
    if (type === 'string') return item.length <= 512 ? textHash(item) : null;
    if (!['number', 'boolean', 'undefined'].includes(type)) return null;
    return textHash(`${type}:${Object.is(item, -0) ? '-0' : String(item)}`);
  };
  function visit(item, depth = 0) {
    if (!item || typeof item !== 'object') return item;
    if (active.has(item)) throw cycle;
    if (seen.has(item)) return seen.get(item);
    if (visited >= nodeLimit || depth >= 64) return item;
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) return item;
    if ('toJSON' in item || (array && item.length > nodeLimit)) return item;
    const ownKeys = Reflect.ownKeys(item);
    if (ownKeys.some(key => typeof key !== 'string')) return item;
    const keys = array ? ownKeys.filter(key => key !== 'length') : ownKeys;
    // Do not normalize sparse arrays or custom array properties.
    if (array && (keys.length !== item.length || keys.some((key, index) => key !== String(index)))) return item;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return item;
    }
    active.add(item);
    visited++;
    let result = item, eligible = keys.length <= 24, hash = array ? 34 : 51;
    for (const key of keys) {
      const old = item[key], child = visit(old, depth + 1);
      if (!Object.is(child, old)) {
        if (result === item) result = array ? item.slice() : { ...item };
        result[key] = child;
      }
      const childHash = child && typeof child === 'object' ? identities.get(child) : scalarHash(child);
      if (childHash == null) eligible = false;
      hash = Math.imul(hash ^ textHash(key), 16777619);
      hash = Math.imul(hash ^ (childHash ?? 0), 16777619);
    }
    active.delete(item);
    if (eligible) {
      let bucket = cache.get(hash);
      if (bucket) for (const candidate of bucket) {
        if (Array.isArray(candidate) !== array) continue;
        const other = Object.keys(candidate);
        if (other.length === keys.length && keys.every((key, index) => key === other[index]
          && Object.is(candidate[key], result[key]))) {
          seen.set(item, candidate);
          hits++;
          return candidate;
        }
      }
      if (entries < entryLimit && (!bucket || bucket.length < 8)) {
        if (!bucket) cache.set(hash, bucket = []);
        bucket.push(result);
        entries++;
        identities.set(result, ++sequence);
      }
    }
    seen.set(item, result);
    return result;
  }
  let result;
  try { result = visit(value); }
  catch (error) { if (error !== cycle) throw error; result = value; }
  try { onStats?.({ entries, hits, visited }); } catch { /* Diagnostics are optional. */ }
  return result;
}
