import { runNativeDemandWorkerJob } from '../runtime/native-demand-worker-job.js';
import { createActiveDemandDiskStore } from '../runtime/active-demand-disk-cache.js';

const WORKER_MARKER = 'open-world-native-demand-worker-evaluator-v3';
const store = createActiveDemandDiskStore();

self.onmessage = async ({ data }) => {
  const { id } = data ?? {};
  try {
    const value = await runNativeDemandWorkerJob(data, { store,
      emitAssignments: assignments => self.postMessage({ id, assignments }),
      resetAssignments: () => self.postMessage({ id, resetAssignments: true }),
    });
    self.postMessage({ id, ok: true, value });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        stack: error?.stack ?? null,
      },
    });
  }
};

self.postMessage({ type: 'ready', marker: WORKER_MARKER });
