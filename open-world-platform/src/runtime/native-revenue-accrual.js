import { backgroundFinanceForHour } from './native-finance-model.js';

const RECEIPT_VERSION = 1;

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireHour(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('hour must be a non-negative safe integer');
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function receiptId(worldId, hour) {
  // Network identity is deliberately absent. A network edit may change the
  // estimate, but it must never make one native hour payable a second time.
  return `native-revenue:v${RECEIPT_VERSION}:${encodeURIComponent(worldId)}:${hour}`;
}

function result({
  status,
  postingId = null,
  networkHash = null,
  hour,
  calculatedRevenue = 0,
  postedRevenue = 0,
  wallet = null,
}) {
  return {
    status,
    postingId,
    networkHash,
    hour,
    calculatedRevenue,
    postedRevenue,
    wallet,
  };
}

/**
 * Revenue-only seam between disposable off-tile projections and the native
 * financial ledger. Native receipts are the sole settlement authority.
 */
export class NativeRevenueAccrual {
  #adapter;

  #profiles = null;

  #networkHash = null;

  #profileSources = null;

  constructor({ adapter } = {}) {
    if (typeof adapter?.postBackgroundNativeFinance !== 'function') {
      throw new TypeError('adapter.postBackgroundNativeFinance must be a function');
    }
    this.#adapter = adapter;
  }

  replaceProfiles({ networkHash, profiles, reuseUnchanged = false } = {}) {
    requireNonEmptyString(networkHash, 'networkHash');
    if (!isRecord(profiles)) throw new TypeError('profiles must be an object keyed by tile id');
    // Runtime compilation replaces each tile profile as a whole. Opt-in
    // callers may reuse that revision identity; ordinary callers still copy.
    const entries = Object.entries(profiles);
    if (reuseUnchanged && networkHash === this.#networkHash
      && this.#profileSources?.size === entries.length
      && entries.every(([id, profile]) => this.#profileSources.get(id) === profile)) {
      return { networkHash, profileCount: entries.length };
    }
    this.#networkHash = networkHash;
    this.#profiles = structuredClone(profiles);
    this.#profileSources = new Map(entries);
    return { networkHash, profileCount: Object.keys(profiles).length };
  }

  invalidate() {
    this.#profiles = null;
    this.#networkHash = null;
    this.#profileSources = null;
  }

  async postHour({ worldId, hour, activeTileId, projection } = {}) {
    requireNonEmptyString(worldId, 'worldId');
    requireHour(hour);
    requireNonEmptyString(activeTileId, 'activeTileId');
    if (!isRecord(projection)) throw new TypeError('projection must be an object');

    if (this.#profiles === null) {
      return result({ status: 'profiles-unavailable', hour });
    }

    const calculated = backgroundFinanceForHour({
      finance: { tileRevenueProfiles: this.#profiles },
      activeTileId,
      activeProjection: projection,
      hour,
      nativeTopologyComplete: true,
    });
    const revenue = Math.max(0, Number(calculated.revenue) || 0);
    if (!(revenue > 0) && !calculated.completedCommutes?.length) {
      return result({
        status: 'no-revenue',
        networkHash: this.#networkHash,
        hour,
      });
    }

    const postingId = receiptId(worldId, hour);
    const revenueByTile = structuredClone(calculated.revenueByTile ?? {});
    const revenueByRoute = structuredClone(calculated.revenueByRoute ?? {});
    // No expense-shaped fields cross this seam. The native game remains the
    // only authority that can calculate or record expenses.
    const adapterResult = await this.#adapter.postBackgroundNativeFinance({
      postingId,
      targetElapsedSeconds: hour * 3_600,
      revenue,
      revenueByTile,
      revenueByRoute,
      completedCommutes: calculated.completedCommutes,
      hourlyPostings: [{ hour, revenue, revenueByTile, revenueByRoute }],
    }, { includeFinancialHistory: false });
    if (typeof adapterResult?.applied !== 'boolean') {
      throw new Error('Native revenue adapter must return an applied receipt result');
    }
    if (!Number.isFinite(adapterResult.wallet)) {
      throw new Error('Native revenue adapter returned an invalid wallet');
    }

    const applied = adapterResult.applied;
    return result({
      status: applied ? 'posted' : 'already-posted',
      postingId,
      networkHash: this.#networkHash,
      hour,
      calculatedRevenue: revenue,
      postedRevenue: applied ? revenue : 0,
      wallet: adapterResult.wallet,
    });
  }
}
