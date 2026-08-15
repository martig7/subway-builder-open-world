import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');
const separator = process.platform === 'win32' ? ';' : ':';
const environment = {
  ...process.env,
  PYTHONPATH: process.env.PYTHONPATH ? `${source}${separator}${process.env.PYTHONPATH}` : source,
};
const result = spawnSync('python', ['-m', 'ny_world_builder.cli', ...process.argv.slice(2)], {
  cwd: root,
  env: environment,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
