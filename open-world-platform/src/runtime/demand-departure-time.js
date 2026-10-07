/** Generated packages use clock strings; native demand uses numeric seconds. */
export function demandDepartureSeconds(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) : null;
}
