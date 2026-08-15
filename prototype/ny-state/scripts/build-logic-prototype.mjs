import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'runtime/logic-prototype.template.html'), 'utf8');
const modelSource = fs.readFileSync(path.join(root, 'runtime/world-runtime-model.js'), 'utf8')
  .replace(/^export\s+/gm, '');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'generated/catalog/tile-catalog.json'), 'utf8'));
const output = template
  .replace('/*__RUNTIME_MODEL__*/', modelSource)
  .replace('/*__TILE_CATALOG__*/null', JSON.stringify(catalog));

if (output.includes('__RUNTIME_MODEL__') || output.includes('__TILE_CATALOG__')) {
  throw new Error('Logic prototype template replacement failed');
}
fs.writeFileSync(path.join(root, 'logic-prototype.html'), output, 'utf8');
console.log(JSON.stringify({ valid: true, output: path.join(root, 'logic-prototype.html'), bytes: Buffer.byteLength(output) }));

