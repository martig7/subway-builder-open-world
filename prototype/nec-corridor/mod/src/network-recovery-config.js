// NEC starts a fresh open-world lineage. This module keeps the recovery seam
// compatible with the NY runtime without importing NY save identifiers or
// route state into the corridor mod.
export const NETWORK_RECOVERY_ID = 'nec-corridor-no-op-recovery-v1';
export const NETWORK_RECOVERY_WORLD_IDS = new Set();
export const NETWORK_RECOVERY_REPLACE_ROUTE_IDS = Object.freeze([]);
