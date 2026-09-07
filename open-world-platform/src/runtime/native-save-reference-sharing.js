export const NATIVE_SAVE_REFERENCE_SHARING_VERSION = 'native-save-reference-sharing-v1';

/** Share identical immutable route lists only in the outgoing save graph.
 * Native JSON values, IDs, record counts and route order remain unchanged. */
export function shareNativeSaveReferences(save) {
  if (!save?.data) return save;
  const paths = new Map(), segments = new Map(), seen = new WeakMap();
  const share = path => {
    if (!Array.isArray(path)) return path;
    if (seen.has(path)) return seen.get(path);
    if (!path.every(s => s && Object.keys(s).length === 2 && typeof s.routeId === 'string'
      && Array.isArray(s.stationIds) && s.stationIds.every(id => typeof id === 'string'))) return path;
    const keys = path.map(s => JSON.stringify([s.routeId, s.stationIds]));
    const key = JSON.stringify(keys);
    let result = paths.get(key);
    if (!result) {
      result = path.map((s,i) => {
        if (!segments.has(keys[i])) segments.set(keys[i],s);
        return segments.get(keys[i]);
      });
      paths.set(key,result);
    }
    seen.set(path,result);return result;
  };
  const records = (rows,field) => Array.isArray(rows) ? rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const path=share(row[field]);return path === row[field] ? row : {...row,[field]:path};
  }) : rows;
  const data={...save.data};
  if (Array.isArray(data.completedCommutes)) data.completedCommutes=records(data.completedCommutes,'stationRoutes');
  if (Array.isArray(data.compressedDemandData?.c)) data.compressedDemandData={...data.compressedDemandData,c:records(data.compressedDemandData.c,'sr')};
  return {...save,data};
}
