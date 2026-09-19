export function prototypeSaveProgressText(state = {}) {
  const elapsed = `${((state.elapsedMs ?? 0) / 1000).toFixed(1)} s`;
  const size = `${((state.progress ?? 0) / 1048576).toFixed(1)} MiB`;
  const label = {
    checking: 'Checking save writer',
    settling: state.waitingFor || 'Waiting for journey calculations to finish',
    generating: 'Preparing native save snapshot',
    connecting: 'Opening save upload',
    uploading: `Encoding and uploading — ${size}`,
    finalizing: `Finishing save on disk — ${size}`,
  }[state.phase] ?? `Saving — ${size}`;
  return `${label} · ${elapsed}`;
}
