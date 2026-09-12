import * as esbuild from '../../node_modules/esbuild/lib/main.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Freeze the original implementation independently of the current branch/HEAD.
const baselineCommit = '3384f8fce72fb6285310f020f323c2f71b7c6812';
const root = path.resolve(import.meta.dirname, '../..');
const repository = path.resolve(root, '..');
const output = path.resolve(process.argv[2] ?? '.analysis/commute-perf-inject-factories.js');
const baseline = execFileSync('git', ['-c', `safe.directory=${repository.replaceAll('\\', '/')}`,
  'show', `${baselineCommit}:open-world-platform/src/runtime/cross-tile-mode-choice.js`],
{ cwd: repository, encoding: 'utf8' });
const sources = {};
for (const variant of ['original', 'javascript', 'wasm']) {
  sources[variant] = {};
  for (const [name, entry] of [['native', 'native-demand-evaluator-worker.js'], ['cross', 'cross-mode-share-worker.js']]) {
    const plugins = [{ name: 'benchmark-kernel', setup(build) {
      if (variant === 'original') build.onLoad({ filter: /cross-tile-mode-choice\.js$/ }, () => ({
        contents: baseline, loader: 'js', resolveDir: path.join(root, 'src/runtime'),
      }));
      if (variant === 'wasm') build.onLoad({ filter: /workers[\\/](native-demand-evaluator-worker|cross-mode-share-worker)\.js$/ }, async args => ({
        contents: `import {createWasmTransitSearch} from '../../experiments/commute-wasm/transit-search.js';\nimport wasmBytes from '../../experiments/commute-wasm/transit-search.wasm';\n`
          + (await readFile(args.path, 'utf8')).replaceAll('createCrossTileRoutingCache()',
            'createCrossTileRoutingCache({searchKernel:createWasmTransitSearch(wasmBytes)})'),
        loader: 'js', resolveDir: path.dirname(args.path),
      }));
    } }];
    const built = await esbuild.build({ absWorkingDir: root, entryPoints: [`src/workers/${entry}`],
      bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
      loader: { '.wasm': 'binary' }, plugins });
    sources[variant][name] = built.outputFiles[0].text;
  }
}
const factories = await esbuild.build({ absWorkingDir: root, stdin: {
  contents: `export {createOffMainThreadNativeDemandEvaluator as createNative} from './src/runtime/embedded-tile-package-adapter.js'; export {createCrossModeShareEvaluator as createCross} from './src/runtime/cross-mode-share-evaluator.js';`,
  resolveDir: root,
}, bundle: true, format: 'iife', globalName: '__commuteBenchmarkFactories', platform: 'browser', target: 'es2022', write: false });
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, factories.outputFiles[0].text + `\nwindow.__commuteBenchmarkSources=${JSON.stringify(sources)};\n({installed:true})`);
console.log(JSON.stringify({ output, baselineCommit, sizes: Object.fromEntries(Object.entries(sources).map(([variant, value]) =>
  [variant, Object.fromEntries(Object.entries(value).map(([name, source]) => [name, source.length]))])) }));
