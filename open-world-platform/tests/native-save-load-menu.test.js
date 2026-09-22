import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSaveReadRenderer } from '../src/installer/native-save-read-patch.js';

const nativeHandler = `  async function handleLoadSave(save2) {
    if (loadingSaveId) return;
    try {
      setLoadingSaveId(save2.id);
      playClickAlt();
      const fullSave = await loadGame(save2.id, save2.autosaveId);
      if (!fullSave) {
        throw new Error("Failed to load save - file may be corrupted or in an unsupported format");
      }
      const saveCityCode = inferCityCodeFromSave(fullSave);
      fullSave.cityCode = saveCityCode;
      if (window.electron?.setPendingSave) {
        await window.electron.setPendingSave(fullSave);
      }
      goToGame({ city: saveCityCode, resume: true });
    } catch (error2) {
      const errorMessage = error2 instanceof Error ? error2.message : "Unknown error occurred";
      logger.error("[LoadSave] Failed to load save:", errorMessage);
      toast2({ title: "Failed to Load Save", description: errorMessage });
    } finally {
      setLoadingSaveId(null);
    }
  }
  async function handleDeleteSave(save2) {}`;

function handler(source, calls, electron) {
  const env = {
    loadingSaveId: null,
    setLoadingSaveId: value => calls.push(['loading', value]),
    playClickAlt: () => {},
    loadGame: async () => { calls.push(['loadGame']); return { cityCode: 'JP_PREF_12' }; },
    inferCityCodeFromSave: save => save.cityCode,
    window: { electron },
    goToGame: value => calls.push(['navigate', value]),
    logger: { error: (...args) => calls.push(['error', ...args]) },
    toast2: value => calls.push(['toast', value]),
  };
  return new Function('env', `with (env) { ${source}\nreturn handleLoadSave; }`)(env);
}

test('Load Game stages the selected native file without two full save crossings', async () => {
  const patched = createNativeSaveReadRenderer(Buffer.from(nativeHandler)).toString();
  assert.match(patched, /OPEN_WORLD_NATIVE_LOAD_MENU_V1/);
  const calls = [];
  const load = handler(patched, calls, {
    loadAndSetPendingSave: async (...args) => {
      calls.push(['stage', ...args]);
      return { success: true, cityCode: 'JP_PREF_12', hasRoutes: true, hasTracks: true };
    },
    setPendingSave: () => assert.fail('full save must not cross the bridge'),
  });
  await load({ id: 'selected.metro', autosaveId: 'auto-1', cityCode: 'JP_PREF_12' });
  assert.deepEqual(calls, [
    ['loading', 'selected.metro'],
    ['stage', 'selected.metro', 'auto-1'],
    ['navigate', { city: 'JP_PREF_12', resume: true }],
    ['loading', null],
  ]);
});

test('Load Game reports native staging failure and preserves the original fallback', async () => {
  const patched = createNativeSaveReadRenderer(Buffer.from(nativeHandler)).toString();
  const failed = [];
  await handler(patched, failed, { loadAndSetPendingSave: async () => ({ success: false, error: 'corrupt file' }) })
    ({ id: 'broken.metro' });
  assert.equal(failed.some(call => call[0] === 'navigate'), false);
  assert.equal(failed.find(call => call[0] === 'toast')[1].description, 'corrupt file');
  const fallback = [];
  await handler(patched, fallback, { setPendingSave: async save => fallback.push(['set', save.cityCode]) })
    ({ id: 'old-host.metro' });
  assert.deepEqual(fallback.filter(call => ['loadGame', 'set', 'navigate'].includes(call[0])), [
    ['loadGame'], ['set', 'JP_PREF_12'], ['navigate', { city: 'JP_PREF_12', resume: true }],
  ]);
});

test('an unknown native menu handler is refused', () => {
  assert.throws(() => createNativeSaveReadRenderer(Buffer.from(nativeHandler.replace('const fullSave', 'const changedSave'))),
    /verified Load Game handler/);
});
