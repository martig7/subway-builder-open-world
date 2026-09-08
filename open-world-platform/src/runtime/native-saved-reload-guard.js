const GUARD = '__openWorldNativeReloadRecoveryGuard__';
const ORIGINAL = '__openWorldNativeReloadRecoveryOriginal__';
const VERSION = '__openWorldNativeReloadRecoveryVersion__';
const SAVED_FILE = '__openWorldSavedReloadFile__';
const SAVE_TIMELINE = '__openWorldSavedReloadTimeline__';
export const NATIVE_SAVED_RELOAD_VERSION = 'native-saved-reload-v4';
const inGame = location => location?.pathname === '/game' || location?.hash?.replace(/^#/, '').split('?')[0] === '/game';
const pendingSave = result => result?.save ?? result?.data ?? null;
const sameSave = (save, file) => {
  if (!save || !file || save.gameSessionId !== file.gameSessionId || save.name !== file.name) return false;
  // The native loader substitutes file mtime for the header timestamp. Its
  // absolute file ID is the stable identity across header queries and loading.
  const savePath = save.path ?? save.id, filePath = file.path ?? file.id;
  return savePath && filePath ? savePath === filePath : save.timestamp === file.timestamp;
};

/** Keep the native loader pointed at a completed Native Save. File decoding
 * stays in Electron's main process; no live snapshot crosses the bridge. */
export function installNativeSavedReloadGuard({ globalObject = globalThis, electron,
  location = globalThis.location, getSessionId, getCityCode, getLoadedSave, now = () => Date.now(), logger = console,
  intervalMs = 15000, setIntervalFn = globalThis.setInterval?.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval?.bind(globalThis) } = {}) {
  const previous = globalObject[GUARD]; previous?.dispose?.();
  const retired = Promise.resolve(previous?.flush?.());
  if (typeof electron?.reloadWindow !== 'function' || typeof electron?.getMostRecentSaves !== 'function'
    || typeof electron?.getPendingSave !== 'function'
    || typeof electron?.loadAndSetPendingSave !== 'function') return {installed:false,dispose() {},flush:async()=>{}};
  let original=electron.reloadWindow;
  while(typeof original?.[ORIGINAL]==='function')original=original[ORIGINAL];
  let disposed=false,pending=null,timer=null,epoch=0,owned=false,checkedSession=null,last=null;
  const stats={queries:0,staged:0,unchanged:0,lastSave:null,error:null};
  const remove = () => (electron.removePendingSave??electron.clearPendingSave)?.call(electron);
  const cleanup = async file => {
    if(typeof electron.getPendingSave!=='function')return;
    const result=await electron.getPendingSave();
    if(result?.success!==false && sameSave(pendingSave(result),file))await remove();
    if (sameSave(globalObject[SAVED_FILE], file)) delete globalObject[SAVED_FILE];
  };
  const fileKey = file => JSON.stringify([file.path ?? file.id, file.timestamp]);
  const prepare = async () => {
    await retired;
    const generation=epoch,session=getSessionId?.(),city=getCityCode?.();
    const cancelled=()=>disposed || generation!==epoch || !inGame(location) || getSessionId?.()!==session || getCityCode?.()!==city;
    if(cancelled() || !session || !city)return {status:'skipped'};
    const loadedSave = getLoadedSave?.();
    const selection = JSON.stringify([session, city, loadedSave?.path]);
    if (globalObject[SAVE_TIMELINE]?.selection !== selection) {
      if (globalObject[SAVE_TIMELINE]) delete globalObject[SAVED_FILE];
      globalObject[SAVE_TIMELINE] = { selection, since: getLoadedSave ? now() : 0 };
    }
    const sessionKey = JSON.stringify([session, city]);
    if(checkedSession!==sessionKey) {
      // Read a full pending payload only once, to preserve an explicitly
      // selected save and retire the preceding live-snapshot implementation.
      const result=await electron.getPendingSave();
      if(cancelled())return {status:'skipped'};
      if(result?.success===false)throw new Error(result.error??'Could not inspect the pending native save');
      const existing=pendingSave(result),legacy=existing?.metadata?.openWorldNativeRecovery;
      owned=!existing || (legacy?.schemaVersion===1 && legacy.reason==='renderer-reload')
        || (previous?.savedFile && sameSave(existing,previous.savedFile))
        || (globalObject[SAVED_FILE] && sameSave(existing,globalObject[SAVED_FILE]))
        || (loadedSave && sameSave(existing, loadedSave));
      const retainedFile = globalObject[SAVED_FILE] ?? previous?.savedFile;
      if (retainedFile && sameSave(existing, retainedFile)) {
        // Autosave retention may already have pruned this file. Its valid
        // pending payload is still in the main process; do not decode it again.
        last = { key: fileKey(retainedFile), file: retainedFile };
        stats.lastSave = retainedFile;
      }
      checkedSession=sessionKey;
    }
    if(!owned)return {status:'preserved-explicit-save'};
    stats.queries++;
    const result=await electron.getMostRecentSaves(20);
    if(cancelled())return {status:'skipped'};
    if(result?.success===false)throw new Error(result.error??'Could not inspect native saves');
    // Do not resurrect a later historical save after the player deliberately
    // loads an older one from the same native session. Only new saves from this
    // load's timeline can replace the selected file or our owned checkpoint.
    const ownedFile = globalObject[SAVED_FILE];
    const fallbackCandidate = ownedFile?.gameSessionId === session && ownedFile?.cityCode === city ? ownedFile : loadedSave;
    // Tile navigation sets currentSaveInfo to an in-memory UUID. Only a real
    // native file can be decoded by loadAndSetPendingSave as a fallback.
    const fallback = /\.(metro|json)$/i.test(fallbackCandidate?.path ?? fallbackCandidate?.id ?? '')
      ? fallbackCandidate : null;
    const file=(result?.saves??[]).filter(f=>f.gameSessionId===session && f.cityCode===city
      && f.timestamp >= globalObject[SAVE_TIMELINE].since && typeof (f.path??f.id)==='string')
      .sort((a,b)=>b.timestamp-a.timestamp)[0] ?? fallback;
    if(!file)return {status:'waiting-for-native-save'};
    const key=fileKey(file);
    if(last?.key===key){stats.unchanged++;return {status:'unchanged'};}
    const loaded=await electron.loadAndSetPendingSave(file.path??file.id,file.autosaveId);
    if(loaded?.success===false)throw new Error(loaded.error??'Could not stage the completed native save');
    if(cancelled()){await cleanup(file);return {status:'skipped'};}
    last={key,file:{name:file.name,timestamp:file.timestamp,gameSessionId:file.gameSessionId,cityCode:file.cityCode,path:file.path??file.id}};
    globalObject[SAVED_FILE] = last.file;
    stats.staged++;stats.lastSave=last.file;stats.error=null;
    return {status:'staged-native-save',file:last.file};
  };
  const checkpoint = () => {
    if(pending)return pending;
    pending=prepare().catch(error=>{stats.error=String(error?.message??error);logger.error?.('[OpenWorld] saved reload guard failed',error);return {status:'failed'};})
      .finally(()=>{pending=null});
    return pending;
  };
  const wrapper=async(...args)=>{
    if(!disposed && inGame(location)){await pending;await checkpoint();}
    return original.apply(electron,args);
  };
  Object.defineProperties(wrapper,{[ORIGINAL]:{value:original},[VERSION]:{value:NATIVE_SAVED_RELOAD_VERSION}});
  let wrapped=false;
  try{electron.reloadWindow=wrapper;wrapped=electron.reloadWindow===wrapper;}catch{}
  const routeChange=()=>{
    epoch++;
    const oldFile=last?.file;
    checkedSession=null;owned=false;last=null;
    if(inGame(location))void checkpoint();
    else if(oldFile)void cleanup(oldFile).catch(error=>logger.error?.('[OpenWorld] saved reload cleanup failed',error));
  };
  const controller={installed:true,version:NATIVE_SAVED_RELOAD_VERSION,mode:wrapped?'wrapper':'saved-file-checkpoint',
    resetForLoad({ bootstrap = false } = {}) {
      // Mod reload replays the currently loaded save before ordinary lifecycle
      // events resume. Its unchanged selection already owns this timeline.
      const selection = JSON.stringify([getSessionId?.(), getCityCode?.(), getLoadedSave?.()?.path]);
      if (bootstrap && globalObject[SAVE_TIMELINE]?.selection === selection) return;
      epoch++; checkedSession=null; owned=false; last=null;
      delete globalObject[SAVE_TIMELINE]; delete globalObject[SAVED_FILE];
    },
    get savedFile(){return last?.file??null;},snapshot:()=>({...stats}),checkpoint,flush:async()=>pending,
    dispose(){if(disposed)return;disposed=true;epoch++;if(timer!=null)clearIntervalFn?.(timer);
      globalObject.removeEventListener?.('hashchange',routeChange);
      if(wrapped && electron.reloadWindow===wrapper)try{electron.reloadWindow=original;}catch{}
      if(globalObject[GUARD]===controller)delete globalObject[GUARD];}};
  globalObject[GUARD]=controller;
  globalObject.addEventListener?.('hashchange',routeChange);
  void checkpoint();
  if(intervalMs>0 && setIntervalFn){timer=setIntervalFn(()=>{void checkpoint();},intervalMs);timer?.unref?.();}
  return controller;
}
