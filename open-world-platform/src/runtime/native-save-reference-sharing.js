import { shareNativeSaveValueReferences } from './native-save-value-sharing.js';

export const NATIVE_SAVE_REFERENCE_SHARING_VERSION = 'native-save-reference-sharing-v2';

/** Share identical values only in the outgoing save graph.
 * Native JSON values, IDs, record counts and route order remain unchanged. */
export function shareNativeSaveReferences(save) {
  if (!save?.data) return save;
  const paths = new Map(), routes = new Map(), seen = new WeakMap();
  let segmentSequence = 0;
  const share = path => {
    if (!Array.isArray(path)) return path;
    if (seen.has(path)) return seen.get(path);
    if (!path.every(s => s && Object.keys(s).length === 2 && typeof s.routeId === 'string'
      && Array.isArray(s.stationIds) && s.stationIds.every(id => typeof id === 'string'))) return path;
    let shared = path;
    const ids = path.map((segment, index) => {
      let segments = routes.get(segment.routeId);
      if (!segments) routes.set(segment.routeId, segments = new Map());
      const key = JSON.stringify(segment.stationIds);
      let entry = segments.get(key);
      if (!entry) segments.set(key, entry = { segment, id: ++segmentSequence });
      if (entry.segment !== segment) {
        if (shared === path) shared = path.slice();
        shared[index] = entry.segment;
      }
      return entry.id;
    });
    const key = ids.join(',');
    let result = paths.get(key);
    if (!result) {
      result = shared;
      paths.set(key,result);
    }
    seen.set(path,result);return result;
  };
  const records = (rows, field) => {
    let result = rows;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row || typeof row !== 'object') continue;
      const path = share(row[field]);
      if (path === row[field]) continue;
      if (result === rows) result = rows.slice();
      result[index] = { ...row, [field]: path };
    }
    return result;
  };
  let data = save.data;
  if (Array.isArray(data.completedCommutes)) {
    const completedCommutes = records(data.completedCommutes, 'stationRoutes');
    if (completedCommutes !== data.completedCommutes) data = { ...data, completedCommutes };
  }
  if (Array.isArray(data.compressedDemandData?.c)) {
    const c = records(data.compressedDemandData.c, 'sr');
    if (c !== data.compressedDemandData.c) data = { ...data, compressedDemandData: { ...data.compressedDemandData, c } };
  }
  if (data.compressedDemandData?.v === 2) {
    for (const key of ['p', 'd']) {
      const source = data.compressedDemandData[key];
      if (!Array.isArray(source)) continue;
      const shared = shareNativeSaveValueReferences(source);
      if (shared !== source) data = { ...data, compressedDemandData: { ...data.compressedDemandData, [key]: shared } };
    }
  }
  if (data.financialHistory && typeof data.financialHistory === 'object') {
    const financialHistory = shareNativeSaveValueReferences(data.financialHistory);
    if (financialHistory !== data.financialHistory) data = { ...data, financialHistory };
  }
  return data === save.data ? save : { ...save, data };
}
