export const GLYPH_WARMUP_VERSION = 'bounded-local-glyph-warmup-v1';
const KEY = '__openWorldGlyphWarmup';
const BUDGET = Symbol.for('open-world.local-glyph-warmup-budget');
// Common label characters, not complete language blocks. Filtered through the
// active manager's local-glyph predicate, and only for fonts already using it.
const COMMON = '一二三四五六七八九十百千上下中大小東西南北山川田森林海島本新古高低長短白黒赤青緑日月火水木金土年市区町村県都府道駅線橋港空谷原野台丘坂池湖浜岸崎沢宮寺神公園学校前後入口出口中央通丁目';
const scheduleIdle = callback => globalThis.requestIdleCallback?.(callback)
  ?? setTimeout(() => callback({ timeRemaining: () => 4 }), 100);
const cancelIdle = id => typeof globalThis.cancelIdleCallback === 'function'
  ? globalThis.cancelIdleCallback(id) : clearTimeout(id);
const scratchBytes = entry => Object.values(entry?.tinySDF ?? {})
  .reduce((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);

/** Warm the native glyph cache without changing rendering or font selection. */
export function attachGlyphWarmup(map, { text = '', maxGlyphs = 128, maxBytes = 2 * 1024 * 1024,
  schedule = scheduleIdle, cancel = cancelIdle, now = () => performance.now(), fonts = globalThis.document?.fonts,
} = {}) {
  const prior = map?.[KEY];
  if (!map || !fonts || typeof fonts.load !== 'function') return null;
  if (prior?.version === GLYPH_WARMUP_VERSION) { prior.kick(); return prior; }
  prior?.dispose?.();
  let disposed = false, pending = null, manager = null, jobs = [], loading = false;
  const processed = new Set();
  const diagnostic = { version: GLYPH_WARMUP_VERSION, status: 'waiting', addedGlyphs: 0,
    addedBufferBytes: 0, maxGlyphs, maxBytes, maxSliceMs: 0, maxGlyphMs: 0, errors: 0 };
  const valid = () => !disposed && map?.style?.glyphManager === manager;
  const moving = () => Boolean(map.isMoving?.());
  function kick() {
    if (disposed || pending !== null || loading || moving()) return;
    pending = schedule(run);
  }
  async function prepare(entry, stack) {
    // Match the installed native TinySDF font selection. Do not replace the
    // configured font or cache a fallback while a web font is still loading.
    const weight = /bold/i.test(stack) ? '900' : /medium/i.test(stack) ? '500' : /light/i.test(stack) ? '200' : '400';
    const font = entry.tinySDF?.ctx?.font ?? `${weight} 48px ${manager.localIdeographFontFamily}`;
    loading = true;
    try { await fonts.load(font, '漢字'); }
    catch { diagnostic.errors++; jobs = []; }
    finally { loading = false; kick(); }
  }
  function run(deadline) {
    pending = null;
    if (disposed || moving()) return;
    const current = map.style?.glyphManager;
    if (current !== manager) {
      manager = current; jobs = []; processed.clear();
      const retained = manager?.[BUDGET];
      diagnostic.addedGlyphs = retained?.addedGlyphs ?? 0;
      diagnostic.addedBufferBytes = retained?.addedBufferBytes ?? 0;
    }
    if (!manager?.localIdeographFontFamily || typeof manager._tinySDF !== 'function'
      || typeof manager._doesCharSupportLocalGlyph !== 'function') {
      diagnostic.status = 'unsupported'; return;
    }
    manager[BUDGET] ??= { addedGlyphs: 0, addedBufferBytes: 0, exhausted: false };
    if (manager[BUDGET].exhausted || diagnostic.addedGlyphs >= maxGlyphs || diagnostic.addedBufferBytes >= maxBytes) {
      diagnostic.status = 'budget-reached'; jobs = []; return;
    }
    if (!jobs.length) {
      for (const [stack, entry] of Object.entries(manager.entries ?? {})) {
        if (processed.size >= 2 || processed.has(stack) || !entry?.glyphs) continue;
        // US/Latin-only maps must not eagerly load a CJK font just because the
        // native manager has a default localIdeographFontFamily configured.
        if (!Object.keys(entry.glyphs).some(id => manager._doesCharSupportLocalGlyph(Number(id)))) continue;
        processed.add(stack);
        const characters = [...new Set(text + COMMON)].slice(0, 256);
        jobs = characters.map(char => ({ entry, stack, code: char.codePointAt(0) }))
          .filter(job => manager._doesCharSupportLocalGlyph(job.code));
        diagnostic.status = 'loading-font';
        void prepare(entry, stack); return;
      }
      diagnostic.status = 'ready'; return;
    }
    const start = now(); let generated = 0;
    diagnostic.status = 'warming';
    while (jobs.length && valid() && !moving() && now() - start < 2 && deadline.timeRemaining() > 2 && generated < 4) {
      const { entry, stack, code } = jobs.shift();
      if (entry.glyphs[code] !== undefined) continue;
      if (diagnostic.addedGlyphs >= maxGlyphs) break;
      const before = scratchBytes(entry), previousTinySDF = entry.tinySDF, glyphStart = now();
      let glyph;
      try { glyph = manager._tinySDF(entry, stack, code); }
      catch {
        if (entry.tinySDF !== previousTinySDF) entry.tinySDF = previousTinySDF;
        diagnostic.errors++; continue;
      }
      diagnostic.maxGlyphMs = Math.max(diagnostic.maxGlyphMs, now() - glyphStart);
      const scratch = Math.max(0, scratchBytes(entry) - before);
      const bytes = glyph?.bitmap?.data?.buffer?.byteLength ?? 0;
      if (diagnostic.addedBufferBytes + scratch + bytes > maxBytes) {
        // The speculative glyph has not been published. Release its newly
        // created rasterizer as well, rather than overshooting the budget.
        if (entry.tinySDF !== previousTinySDF) entry.tinySDF = previousTinySDF;
        manager[BUDGET].exhausted = true;
        diagnostic.status = 'budget-reached'; jobs = []; break;
      }
      diagnostic.addedBufferBytes += scratch;
      if (glyph && entry.glyphs[code] === undefined) {
        entry.glyphs[code] = glyph;
        diagnostic.addedGlyphs++; diagnostic.addedBufferBytes += bytes; generated++;
      }
    }
    Object.assign(manager[BUDGET], { addedGlyphs: diagnostic.addedGlyphs, addedBufferBytes: diagnostic.addedBufferBytes });
    diagnostic.maxSliceMs = Math.max(diagnostic.maxSliceMs, now() - start);
    if (diagnostic.status !== 'budget-reached') kick();
  }
  const controller = { version: GLYPH_WARMUP_VERSION, diagnostic, kick,
    dispose() {
      disposed = true;
      if (pending !== null) cancel(pending);
      pending = null; jobs = [];
      map.off?.('styledata', kick); map.off?.('moveend', kick);
      if (map[KEY] === controller) delete map[KEY];
    },
  };
  map[KEY] = controller;
  map.on?.('styledata', kick); map.on?.('moveend', kick); kick();
  return controller;
}
