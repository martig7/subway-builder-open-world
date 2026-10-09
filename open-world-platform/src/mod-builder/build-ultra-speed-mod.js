import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { ULTRA_SPEED_MOD_ID, ULTRA_SPEED_STANDALONE_VERSION } from '../runtime/start-ultra-speed.js';

// A tiny deterministic ZIP writer for this two-file release (no ZIP64 needed).
function releaseZip(files) {
  const local = [], directory = []; let offset = 0;
  for (const [filename, bytes] of files) {
    const name = Buffer.from(filename), compressed = deflateRawSync(bytes), checksum = crc32(bytes);
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); local.push(header, name, compressed); directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const entries = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(entries.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, entries, end]);
}

/** Build from platform sources without reading World artifacts or installing. */
export async function buildUltraSpeedMod({ modRoot }) {
  const { build } = await import('esbuild');
  const platformRoot = path.resolve(import.meta.dirname, '..', '..');
  const manifest = JSON.parse(await readFile(path.join(modRoot, 'manifest.json'), 'utf8'));
  if (manifest.id !== ULTRA_SPEED_MOD_ID || manifest.main !== 'index.js') throw new Error('Unexpected Ultra speed manifest');
  const options = { bundle: true, format: 'iife', platform: 'browser', target: 'es2022', legalComments: 'none', write: false };
  const workerSources = {};
  for (const [name, filename] of Object.entries({ nativeDemandEvaluator: 'native-demand-evaluator-worker.js', hourlyFinance: 'hourly-finance-worker.js' })) {
    const built = await build({ ...options, entryPoints: [path.join(platformRoot, 'src', 'workers', filename)] });
    workerSources[name] = built.outputFiles[0].text;
  }
  const built = await build({ ...options, metafile: true, stdin: {
    contents: `import { startUltraSpeed } from './src/runtime/start-ultra-speed.js';
startUltraSpeed({ workerSources: ${JSON.stringify(workerSources)} }).catch(error => {
  console.error('[Ultra Speed] startup failed', error);
  globalThis.SubwayBuilderAPI?.ui?.showNotification?.(String(error.message ?? error), 'error', 'Ultra Speed');
});`, resolveDir: platformRoot, sourcefile: 'ultra-speed-entry.js', loader: 'js' } });
  if (Object.keys(built.metafile.inputs).some(file => /start-open-world|world-tile-runtime|tile-server-health/.test(file))) {
    throw new Error('Standalone release unexpectedly includes World startup or tile-server runtime');
  }
  const bundle = built.outputFiles[0].contents;
  if (!Buffer.from(bundle).includes(Buffer.from(ULTRA_SPEED_STANDALONE_VERSION))) throw new Error('Missing standalone implementation marker');
  const distPath = path.join(modRoot, 'dist');
  await mkdir(distPath, { recursive: true });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(distPath, 'index.js'), bundle);
  await writeFile(path.join(distPath, 'manifest.json'), manifestBytes);
  const archivePath = path.join(distPath, `ultra-speed-${manifest.version}.zip`);
  await writeFile(archivePath, releaseZip([['manifest.json', manifestBytes], ['index.js', bundle]]));
  return { manifest, distPath, archivePath, inputs: Object.keys(built.metafile.inputs) };
}
