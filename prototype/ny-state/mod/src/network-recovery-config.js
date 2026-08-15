export const NETWORK_RECOVERY_ID = 'ny-player-network-2026-08-14-full-corridor-autosave-loss-v9';

export const NETWORK_RECOVERY_WORLD_IDS = new Set([
  '220a5a58-5c33-41e0-8680-d80862153908',
  '9ef84dc9-4441-4712-af2c-5613bb9264b6',
  '91ca6ae2-1661-4642-823b-3652204c1537',
  // Current aliased lineage: a valid checkpoint retained only the Albany
  // facade, then recomputed every remote revenue profile to zero. Reapply the
  // complete embedded corridor once before finance compilation can commit.
  '969e5d4d-62d2-463f-99b2-235ca101f372',
]);

export const NETWORK_RECOVERY_SIDECAR_ROUTE_IDS = Object.freeze([
  '2a6cb02f-4a78-4ac0-b0d0-16fef8c755bb', // Empire Line
  'da40e3d7-1257-41af-b10d-eec737d47467', // 101
  '22db486a-28d5-4b6d-899c-e986335c6f93', // 102
  'a707a2be-d39a-400b-b73a-f2b61ee4e639', // 103
  'b13a0ef3-deec-473b-88d1-d7bdc2d4acac', // Long Island Line
]);

export const NETWORK_RECOVERY_NATIVE_ROUTE_IDS = Object.freeze([
  'd7b58cd2-b68c-4fc5-b860-b3747e0b97d5', // 1
  '36901c8e-b76c-4d3e-921e-adb1860286f0', // A
  '9160dcdd-30d2-4a7e-821e-c560a45b48a5', // F
]);

export const NETWORK_RECOVERY_ROUTE_IDS = Object.freeze([
  ...NETWORK_RECOVERY_SIDECAR_ROUTE_IDS,
  ...NETWORK_RECOVERY_NATIVE_ROUTE_IDS,
]);

export const NETWORK_RECOVERY_REPLACE_ROUTE_IDS = Object.freeze([
  // The autosave loss retained a three-stop native facade over the former
  // seven-stop Empire Line. Restore this one known-truncated canonical route;
  // all healthy live route records continue to win over the backup.
  '2a6cb02f-4a78-4ac0-b0d0-16fef8c755bb',
]);
