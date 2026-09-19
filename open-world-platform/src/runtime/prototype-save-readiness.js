export const PROTOTYPE_SAVE_READINESS_VERSION = 'prototype-save-work-readiness-v1';

export function prototypeSaveBusyReason({ nativeWorkers, simulation } = {}) {
  // logicalWorkers counts historical construction, not unfinished work. A
  // cached-only session can legitimately never construct a native pool.
  if (!simulation?.saveWork?.observed) return 'Cannot observe simulation work. Reload the Open World mod before retrying';
  if (simulation.saveWork.native) return 'Waiting for native simulation to finish';
  if (nativeWorkers?.busy || nativeWorkers?.queued) return `Waiting for journey calculations (${nativeWorkers.busy} running, ${nativeWorkers.queued} queued)`;
  if (simulation?.status === 'calculating') return 'Waiting for cached journey calculations';
  if (simulation.saveWork.cached) return 'Waiting for cached simulation to finish';
  return false;
}
