import { open } from 'node:fs/promises';

const archivePath = process.argv[2];
const pattern = new RegExp(process.argv[3] ?? '.', 'i');
if (!archivePath) throw new Error('Usage: node recovery/list-asar.mjs <archive> [pattern]');

const handle = await open(archivePath, 'r');
try {
  const prefix = Buffer.alloc(16);
  await handle.read(prefix, 0, prefix.length, 0);
  const headerSize = prefix.readUInt32LE(4);
  const jsonSize = prefix.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  await handle.read(json, 0, json.length, 16);
  const header = JSON.parse(json.toString('utf8'));
  const matches = [];
  const visit = (node, parent = '') => {
    for (const [name, entry] of Object.entries(node?.files ?? {})) {
      const relativePath = parent ? `${parent}/${name}` : name;
      if (entry.files) visit(entry, relativePath);
      else if (pattern.test(relativePath)) matches.push({ path: relativePath, size: entry.size, offset: entry.offset, unpacked: entry.unpacked === true });
    }
  };
  visit(header);
  console.log(JSON.stringify({ headerSize, dataOffset: 8 + headerSize, matches }, null, 2));
} finally {
  await handle.close();
}
