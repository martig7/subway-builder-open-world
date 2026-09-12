import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

function archiveHeader(archive) {
  if (archive.length < 16 || archive.readUInt32LE(0) !== 4) throw new Error('Invalid ASAR header');
  const dataOffset = 8 + archive.readUInt32LE(4);
  const jsonSize = archive.readUInt32LE(12);
  if (16 + jsonSize > dataOffset || dataOffset > archive.length) throw new Error('Invalid ASAR bounds');
  return { header: JSON.parse(archive.subarray(16, 16 + jsonSize).toString('utf8')), dataOffset };
}

function entryAt(header, filename) {
  let entry = header;
  for (const part of filename.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error('Invalid ASAR entry path');
    entry = entry.files?.[part];
    if (!entry) throw new Error(`Missing ASAR entry: ${filename}`);
  }
  if (entry.unpacked || entry.link || !Number.isSafeInteger(entry.size)) throw new Error('Expected a packed ASAR file');
  return entry;
}

export function readAsarEntry(archive, filename) {
  const { header, dataOffset } = archiveHeader(archive);
  const entry = entryAt(header, filename), offset = Number(entry.offset);
  if (!Number.isSafeInteger(offset) || offset < 0 || entry.size < 0
    || dataOffset + offset + entry.size > archive.length) throw new Error('Invalid ASAR entry bounds');
  return archive.subarray(dataOffset + offset, dataOffset + offset + entry.size);
}

/** Append a replacement, preserving every byte and offset in the original
 * payload. Only the selected entry's header and integrity fields change. */
export function replaceAsarEntry(archive, filename, replacement) {
  readAsarEntry(archive, filename);
  const { header, dataOffset } = archiveHeader(archive);
  const entry = entryAt(header, filename), payload = archive.subarray(dataOffset);
  entry.offset = String(payload.length);
  entry.size = replacement.length;
  if (entry.integrity) {
    if (entry.integrity.algorithm !== 'SHA256') throw new Error('Unsupported ASAR integrity algorithm');
    const blockSize = entry.integrity.blockSize;
    if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error('Invalid ASAR integrity block size');
    entry.integrity.hash = sha256(replacement);
    entry.integrity.blocks = [];
    for (let offset = 0; offset < replacement.length; offset += blockSize) {
      entry.integrity.blocks.push(sha256(replacement.subarray(offset, offset + blockSize)));
    }
  }
  const json = Buffer.from(JSON.stringify(header));
  const headerPayloadSize = 4 + Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(12 + headerPayloadSize);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerPayloadSize + 4, 4);
  prefix.writeUInt32LE(headerPayloadSize, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  return Buffer.concat([prefix, payload, replacement]);
}
