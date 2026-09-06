import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const TILE_DATA_FILES = ['demand_data.json.gz', 'buildings_index.bin.gz', 'roads.geojson.gz', 'runways_taxiways.geojson.gz', 'tiles.pmtiles'];
export const WORLD_DATA_FILES = ['cross_commutes.json', 'cross_demand.json.gz'];

async function fileSignature(filePath) {
  try {
    const value = await stat(filePath, { bigint: true });
    if (!value.isFile() || value.size === 0n) return null;
    return `${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function identity(filePath, previous, repair) {
  const signature = await fileSignature(filePath);
  if (signature == null) return null;
  if (!repair && previous?.path === filePath && previous.signature === signature && /^[a-f0-9]{64}$/.test(previous.sha256 ?? '')) return previous;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  if (await fileSignature(filePath) !== signature) throw new Error(`Artifact changed while hashing: ${filePath}`);
  return { path: filePath, signature, sha256: hash.digest('hex') };
}

/** Plan before taking any service offline. Cached hashes are valid only while
 * path, size, mtime and ctime match; --repair verifies every byte again. */
export async function planArtifactFiles(entries, { previous = {}, repair = false } = {}) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {};
  const files = [];
  for (const entry of entries) {
    const source = await identity(entry.source, previous[entry.key]?.source, repair);
    if (!source) throw new Error(`Required artifact is missing or empty: ${entry.source}`);
    const target = await identity(entry.target, previous[entry.key]?.target, repair);
    files.push({ ...entry, sourceIdentity: source, targetIdentity: target, changed: repair || target?.sha256 !== source.sha256 });
  }
  return { files, changed: files.filter(file => file.changed).length };
}

export async function applyArtifactFiles(plan) {
  const state = {};
  for (const file of plan.files) {
    if (await fileSignature(file.source) !== file.sourceIdentity.signature) throw new Error(`Artifact changed after planning: ${file.source}`);
    if (file.changed) {
      await mkdir(path.dirname(file.target), { recursive: true });
      await copyFile(file.source, file.target);
      if (await fileSignature(file.source) !== file.sourceIdentity.signature) throw new Error(`Artifact changed while copying: ${file.source}`);
    } else if (await fileSignature(file.target) !== file.targetIdentity.signature) {
      throw new Error(`Installed artifact changed after planning: ${file.target}`);
    }
    state[file.key] = {
      source: file.sourceIdentity,
      target: { path: file.target, signature: await fileSignature(file.target), sha256: file.sourceIdentity.sha256 },
    };
  }
  return state;
}
