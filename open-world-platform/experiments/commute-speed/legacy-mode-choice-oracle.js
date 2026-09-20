// Frozen legacy mode-choice oracle from af425106788299b4648d1fa104b3c5e544e28db3.
// Keep independent of production so historical experiment parity survives promotion.
const DEFAULT_RULES = Object.freeze({
  MAX_WALK_TO_FROM_STATION: 30 * 60,
  MAX_DRIVE_TO_FROM_STATION: 7 * 60,
  DRIVE_TO_STATION_ACCESS: false,
  DRIVING_COST_PER_KM: 0.65,
  MIN_SENSIBLE_DRIVING_DISTANCE: 1_000,
  PARKING_TIME: 180,
  PARKING_COST: 5,
  INCOME_MEAN: 60_000,
  INCOME_STD_DEV: 25_000,
  MINIMUM_INCOME: 15_000,
  MAXIMUM_INCOME: 200_000,
  HOURS_WORKED_PER_YEAR: 1_860,
  MIN_TRANSIT_CHOICE: 10,
  ARRIVAL_GAP: 50,
  DRIVING_TIMES: {
    VERY_LOW_DEMAND: 0.8,
    LOW_DEMAND: 0.9,
    LOW_MEDIUM_DEMAND: 1,
    MEDIUM_DEMAND: 1.25,
    HIGH_DEMAND: 1.5,
  },
  PERCEIVED_TIME: {
    WALK_MULTIPLIER: 1.39,
    WAIT_MULTIPLIER: 1.37,
    DEPARTURE_SHIFT_MULTIPLIER: 0.4,
    CONGESTED_DRIVING_MULTIPLIER: 1.33,
    CONGESTION_FULL_AT_MULTIPLIER: 2,
    PARKING_SEARCH_MULTIPLIER: 1.6,
  },
});

function finite(value, fallback) { return Number.isFinite(value) ? value : fallback; }

function rulesWithDefaults(raw = {}) {
  return {
    ...DEFAULT_RULES,
    ...raw,
    DRIVING_TIMES: { ...DEFAULT_RULES.DRIVING_TIMES, ...(raw.DRIVING_TIMES ?? {}) },
    PERCEIVED_TIME: { ...DEFAULT_RULES.PERCEIVED_TIME, ...(raw.PERCEIVED_TIME ?? {}) },
  };
}

function inverseNormalCDF(value) {
  const p = Math.max(1e-4, Math.min(0.9999, value));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 0.97575) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function incomeForPerson(index, population, rules) {
  const percentile = index / Math.max(population - 1, 1);
  let income = rules.INCOME_MEAN + inverseNormalCDF(percentile) * rules.INCOME_STD_DEV;
  income = Math.max(rules.MINIMUM_INCOME, Math.min(income, rules.MAXIMUM_INCOME));
  const noise = (index * 362436069 % 1e6) / 1e6;
  if (income <= rules.MINIMUM_INCOME + 5_000) income = rules.INCOME_MEAN + inverseNormalCDF(0.1 + noise * 0.85) * rules.INCOME_STD_DEV;
  else if (noise < 0.1) income += ((index * 123456789 % 1e6) / 1e6) * 100_000;
  return Math.max(rules.MINIMUM_INCOME, Math.min(income, rules.MAXIMUM_INCOME));
}

const incomeValueDistributionCache = new Map();

function incomeValueDistribution(population, rules) {
  const key = [
    population,
    rules.INCOME_MEAN,
    rules.INCOME_STD_DEV,
    rules.MINIMUM_INCOME,
    rules.MAXIMUM_INCOME,
    rules.HOURS_WORKED_PER_YEAR,
  ].join('|');
  let values = incomeValueDistributionCache.get(key);
  if (values) return values;
  values = new Float64Array(Math.max(0, Math.ceil(population)));
  for (let index = 0; index < values.length; index++) {
    values[index] = incomeForPerson(index, population, rules) / rules.HOURS_WORKED_PER_YEAR / 3_600;
  }
  incomeValueDistributionCache.set(key, values);
  return values;
}

function chooseModesFromMetrics(population, rules, metrics) {
  const result = { driving: 0, walking: 0, transit: 0, unknown: 0 };
  const drivingTimeCost = metrics.driving.perceivedSeconds * metrics.driving.shortTripPenalty;
  const drivingMoneyCost = metrics.driving.moneyCost * metrics.driving.shortTripPenalty;
  const transitTimeCost = metrics.transit.perceivedSeconds;
  const transitMoneyCost = metrics.transit.moneyCost;
  const walkingTimeCost = metrics.walking.perceivedSeconds;
  for (const hourlyValue of incomeValueDistribution(population, rules)) {
    let bestCost = drivingTimeCost * hourlyValue + drivingMoneyCost;
    let mode = 'driving';
    const transitGeneralizedCost = transitTimeCost * hourlyValue + transitMoneyCost;
    if (transitGeneralizedCost < bestCost) { bestCost = transitGeneralizedCost; mode = 'transit'; }
    if (walkingTimeCost * hourlyValue < bestCost) mode = 'walking';
    result[mode] += 1;
  }
  if (result.transit < rules.MIN_TRANSIT_CHOICE) { result.driving += result.transit; result.transit = 0; }
  return result;
}

export { chooseModesFromMetrics, incomeForPerson, rulesWithDefaults };
