import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const compiler = process.env.WASM_CLANG;
if (!compiler) throw new Error('Set WASM_CLANG to the WASI SDK clang executable.');
const flags = ['--target=wasm32-unknown-unknown', '-O3', '-ffp-contract=off', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  '-DPARTITION_EXPERIMENT', '-Wl,--no-entry', '-Wl,--export=search', '-Wl,--export=label_size', '-Wl,--export=heap_entry_size',
  '-Wl,--export=set_partition_bounds', '-Wl,--export=partition_pruned', '-Wl,--export=__heap_base',
  '-Wl,--initial-memory=131072', '-Wl,--max-memory=268435456',
  path.join(import.meta.dirname, '../commute-wasm/transit-search.cpp'), '-o', path.join(import.meta.dirname, 'transit-search.wasm')];
const result = spawnSync(compiler, flags, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const bytes = await readFile(path.join(import.meta.dirname, 'transit-search.wasm'));
console.log(JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), flags }));
