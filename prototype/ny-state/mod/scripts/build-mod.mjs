import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  mergeRecoveryStates,
  selectRouteRecoveryState,
} from '../../../kc-two-tile/mod/src/network-recovery.js';
import { decodeMetroSave } from '../../../kc-two-tile/mod/scripts/inspect-metro-save.mjs';
import {
  NETWORK_RECOVERY_NATIVE_ROUTE_IDS,
  NETWORK_RECOVERY_SIDECAR_ROUTE_IDS,
} from '../src/network-recovery-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimeDataRoot = path.resolve(root, '..', 'generated', 'pilot', 'tiles', 'NY_CP00_RP00');
const commuteCatalog = JSON.parse(await readFile(path.join(runtimeDataRoot, 'cross_commutes.json'), 'utf8'));
const crossDemandGzipBase64 = (await readFile(path.join(runtimeDataRoot, 'cross_demand.json.gz'))).toString('base64');
const recoveryBackupPath = process.env.NY_STATE_NETWORK_RECOVERY_BACKUP ?? path.join(
  process.env.APPDATA ?? '',
  'metro-maker4',
  'mod-data',
  'local.ny-state-six-tile-canary.json.pre-session-binding-1786566478893.bak',
);
const recoveryStore = JSON.parse(await readFile(recoveryBackupPath, 'utf8'));
const recoveryWorld = recoveryStore['world:4f049ce2-0eed-41f3-a247-8af1b8ed2bb6'];
if (!recoveryWorld?.globalNetwork?.nativeState) throw new Error(`Recovery network absent from ${recoveryBackupPath}`);
const sidecarRecoveryState = selectRouteRecoveryState(
  recoveryWorld.globalNetwork.nativeState,
  NETWORK_RECOVERY_SIDECAR_ROUTE_IDS,
);
const recoveryMetroPath = process.env.NY_STATE_NETWORK_RECOVERY_METRO ?? path.join(
  'D:',
  'SubwayBuilder',
  'asdsada_d6c9fa587af64f4b89e84f42ec5e3818.metro',
);
const metroContainer = decodeMetroSave(recoveryMetroPath);
const metroNativeState = metroContainer?.mainSave?.data ?? metroContainer?.data;
if (!metroNativeState) throw new Error(`Native recovery network absent from ${recoveryMetroPath}`);
const nativeRecoveryState = selectRouteRecoveryState(
  metroNativeState,
  NETWORK_RECOVERY_NATIVE_ROUTE_IDS,
);
// The sidecar is authoritative for regional topology. Applying it second keeps
// its remote Empire/Long Island records when a shared entity also appears in
// the NYC save, while the native save contributes the otherwise absent F/A/1.
const routeRecoveryState = mergeRecoveryStates(nativeRecoveryState, sidecarRecoveryState);
const networkRecoveryGzipBase64 = gzipSync(
  JSON.stringify(routeRecoveryState),
  { level: 9 },
).toString('base64');
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  // The KC prototype already pins the same compiler; reuse it in this shared
  // workspace so the canary can be rebuilt offline.
  esbuild = await import('../../../kc-two-tile/mod/node_modules/esbuild/lib/main.js');
}
await mkdir(path.join(root, 'dist'), { recursive: true });
await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'src', 'game-entry.js')],
  outfile: path.join(root, 'dist', 'index.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  legalComments: 'none',
  define: {
    __NY_CROSS_COMMUTE_CATALOG__: JSON.stringify(commuteCatalog),
    __NY_CROSS_DEMAND_GZIP_BASE64__: JSON.stringify(crossDemandGzipBase64),
    __NY_NETWORK_RECOVERY_GZIP_BASE64__: JSON.stringify(networkRecoveryGzipBase64),
  },
});
await copyFile(path.join(root, 'manifest.json'), path.join(root, 'dist', 'manifest.json'));
console.log('Built New York seven-tile corridor performance canary');
