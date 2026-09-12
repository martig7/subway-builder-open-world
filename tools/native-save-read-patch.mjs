import { readFile } from 'node:fs/promises';
import { prepareNativeSaveReadPatch, applyNativeSaveReadPatch, restoreNativeSaveReadPatch } from '../open-world-platform/src/installer/native-save-read-patch.js';

const [command, target, outputPath] = process.argv.slice(2);
if (command === 'prepare' && target && outputPath) {
  console.log(JSON.stringify(await prepareNativeSaveReadPatch({ gameRoot: target, outputPath }), null, 2));
} else if (command === 'apply' && target) {
  console.log(JSON.stringify(await applyNativeSaveReadPatch(JSON.parse(await readFile(target, 'utf8'))), null, 2));
} else if (command === 'restore' && target) {
  console.log(JSON.stringify(await restoreNativeSaveReadPatch({ gameRoot: target }), null, 2));
} else {
  throw new Error('Usage: native-save-read-patch.mjs prepare <game-directory> <staged-asar> | apply <plan-json> | restore <game-directory>. Close the game before apply/restore.');
}
