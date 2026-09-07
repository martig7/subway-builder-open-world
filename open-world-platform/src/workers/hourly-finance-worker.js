import { cachedSimulationPosting } from '../runtime/cached-simulation-posting.js';
let profile = null;
globalThis.onmessage = ({ data }) => {
  if (data.type === 'profile') { profile = data; return; }
  if (data.type !== 'prepare') return;
  try {
    if (profile?.revision !== data.revision) throw new Error('Stale hourly profile');
    const posting = cachedSimulationPosting({ ...profile.input, from: data.from, to: data.to });
    globalThis.postMessage({ id: data.id, revision: data.revision, posting });
  } catch (error) {
    globalThis.postMessage({ id: data.id, revision: data.revision, error: String(error?.message ?? error) });
  }
};
