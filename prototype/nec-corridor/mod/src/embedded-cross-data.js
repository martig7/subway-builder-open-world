// These build-time constants are replaced by esbuild. Keeping the statewide
// payload in the mod avoids file:// URL resolution inside Electron.
export const embeddedCrossData = Object.freeze({
  commuteCatalog: __NEC_CROSS_COMMUTE_CATALOG__,
  crossDemandGzipBase64: __NEC_CROSS_DEMAND_GZIP_BASE64__,
});
