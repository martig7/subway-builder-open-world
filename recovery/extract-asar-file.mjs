import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [archivePath, wantedPath, destinationPath] = process.argv.slice(2);
if (!archivePath || !wantedPath || !destinationPath) {
  throw new Error('Usage: node recovery/extract-asar-file.mjs <archive> <entry> <destination>');
}

const handle = await open(archivePath, 'r');
try {
  const prefix = Buffer.alloc(16);
  await handle.read(prefix, 0, prefix.length, 0);
  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  await handle.read(json, 0, json.length, 16);
  const header = JSON.parse(json.toString('utf8'));
  const entry = wantedPath.split('/').reduce((node, segment) => node?.files?.[segment], header);
  if (!entry || entry.files || entry.unpacked) throw new Error(`Packed file not found: ${wantedPath}`);
  const data = Buffer.alloc(Number(entry.size));
  const position = 8 + headerSize + Number(entry.offset);
  await handle.read(data, 0, data.length, position);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, data);
  console.log(JSON.stringify({ wantedPath, destinationPath, bytes: data.length, position }));
} finally {
  await handle.close();
}
