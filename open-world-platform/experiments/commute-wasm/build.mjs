import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const compiler = process.env.WASM_CLANG;
if (!compiler) throw new Error('Set WASM_CLANG to a clang compiler with the wasm32 target and wasm-ld alongside it.');
const flags = ['--target=wasm32-unknown-unknown', '-O3', '-ffp-contract=off', '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
  '-Wl,--no-entry', '-Wl,--export=search', '-Wl,--export=label_size', '-Wl,--export=heap_entry_size', '-Wl,--export=__heap_base',
  '-Wl,--initial-memory=131072', '-Wl,--max-memory=268435456',
  path.join(import.meta.dirname, 'transit-search.cpp'), '-o', path.join(import.meta.dirname, 'transit-search.wasm')];
const result = spawnSync(compiler, flags, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const bytes = await readFile(path.join(import.meta.dirname, 'transit-search.wasm'));
console.log(JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), flags }));
