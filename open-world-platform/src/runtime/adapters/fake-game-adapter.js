import { deepCopy } from '../world-model.js';
import { mergeSharedTransitNetworkState, SHARED_TRANSIT_STATE_KEYS } from '../shared-transit-network.js';
import { backfillHourlyFinancialHistory, backfillHourlyRouteFinancials } from '../native-finance-model.js';

/** In-memory game seam. Its failures make transaction recovery testable. */
export class FakeGameAdapter {
  constructor({ version = '1.6.0', failAt = null } = {}) {
    this.version = version; this.failAt = failAt; this.paused = false; this.currentPackage = null;
    this.native = {
      clock: 0, wallet: 0, gameMode: 'easy', transitCost: 2.5, fareGroups: [], camera: { x: 0, y: 0, zoom: 1 }, objects: [], activity: { departures: [], walletDelta: 0 },
      financialHistory: { entries: [], lastHourTimestamp: 0, currentHourRevenue: 0, currentHourExpenses: 0, currentHourExpenseCategories: {} },
      routeFinancials: { byRoute: {}, lastHourTimestamp: 0, currentHour: {} },
      bonds: [], hasGoneBankrupt: false, rockefellerPaidOut: false, buildingDemolitionSpendAllTime: 0,
      routeRevenueByRoute: {}, completedCommutes: [],
    };
    this.log = [];
    this.nativeFinanceAudit = [];
  }
  async assertSupported() { if (this.version !== '1.6.0') throw new Error(`Unsupported game version: ${this.version}`); }
  async #at(name) { this.log.push(name); if (this.failAt === name) throw new Error(`Injected game failure at ${name}`); }
  async pause() { await this.#at('pause'); this.paused = true; }
  async resume() { await this.#at('resume'); this.paused = false; }
  async isPaused() { return this.paused; }
  async captureSnapshot() { await this.#at('captureSnapshot'); return deepCopy(this.native); }
  async captureNativeNetworkState() {
    await this.#at('captureNativeNetworkState');
    const entityKeys = new Set(['tracks', 'trains', 'routes', 'trackGroups', 'signals', 'stNodes', 'stations', 'stationGroups']);
    return Object.fromEntries(SHARED_TRANSIT_STATE_KEYS.map((key) => [
      key,
      deepCopy(this.native[key] ?? (entityKeys.has(key) ? [] : null)),
    ]));
  }
  inspectNativeNetworkForDiagnostics() {
    return {
      tracks: this.native.tracks?.length ?? 0,
      trackGroups: this.native.trackGroups?.length ?? 0,
      stations: this.native.stations?.length ?? 0,
      routes: this.native.routes?.length ?? 0,
      trains: this.native.trains?.length ?? 0,
      routeInventory: (this.native.routes ?? []).map((route) => ({
        id: route?.id ?? null,
        bullet: route?.bullet ?? null,
        name: route?.fullName ?? route?.name ?? null,
      })),
    };
  }
  readWorldIdentityHints() {
    const authoritativeWorldId = this.native.financialHistory?.openWorldAuthoritativeWorldId;
    return {
      authoritativeWorldId: typeof authoritativeWorldId === 'string' && authoritativeWorldId
        ? authoritativeWorldId
        : null,
      ancestorSessionIds: typeof this.native.gameSessionId === 'string' && this.native.gameSessionId
        ? [this.native.gameSessionId]
        : [],
    };
  }
  async stampAuthoritativeWorldIdentity(worldId) {
    await this.#at('stampAuthoritativeWorldIdentity');
    if (typeof worldId !== 'string' || !worldId) {
      throw new Error('Authoritative world identity must be a non-empty string');
    }
    if (this.native.financialHistory.openWorldAuthoritativeWorldId === worldId) return false;
    this.native.financialHistory.openWorldAuthoritativeWorldId = worldId;
    return true;
  }
  async captureAuthoritativeGlobals() {
    await this.#at('captureAuthoritativeGlobals');
    return { wallet: this.native.wallet, elapsedSeconds: this.native.clock, gameMode: this.native.gameMode, farePolicy: { fare: this.native.transitCost, fareGroups: deepCopy(this.native.fareGroups ?? []) }, financialHistory: deepCopy(this.native.financialHistory) };
  }
  queueNativeFinanceAudit(sample) { this.nativeFinanceAudit.push(deepCopy(sample)); }
  consumeNativeFinanceAudit() {
    const samples = deepCopy(this.nativeFinanceAudit);
    this.nativeFinanceAudit = [];
    return samples;
  }
  getJourneyFare(segments) { return typeof this.native.getJourneyFare === 'function' ? this.native.getJourneyFare(segments) : null; }
  async creditCrossTileFareRevenue(amount, attribution = {}) {
    await this.#at('creditCrossTileFareRevenue');
    const known = new Set(this.native.completedCommutes.map((commute) => commute?.popId));
    const requested = attribution.completedCommutes ?? [];
    const fresh = requested.filter((commute) => !known.has(commute?.popId));
    const retry = requested.length > 0 && fresh.length !== requested.length;
    const effectiveAmount = retry
      ? fresh.reduce((total, commute) => total + (Number(commute.fareRevenue) || 0), 0)
      : amount;
    const effectiveRoutes = retry
      ? fresh.reduce((totals, commute) => {
        for (const [routeId, revenue] of Object.entries(commute.revenueByRoute ?? {})) totals[routeId] = (totals[routeId] ?? 0) + revenue;
        return totals;
      }, {})
      : attribution.revenueByRoute ?? {};
    this.native.wallet += effectiveAmount;
    this.native.financialHistory.currentHourRevenue += effectiveAmount;
    for (const [routeId, revenue] of Object.entries(effectiveRoutes)) {
      this.native.routeRevenueByRoute[routeId] = (this.native.routeRevenueByRoute[routeId] ?? 0) + revenue;
    }
    this.native.completedCommutes.push(...deepCopy(fresh));
    return { wallet: this.native.wallet, financialHistory: deepCopy(this.native.financialHistory) };
  }
  calculateNativeFinanceProfile(tileId = this.currentPackage?.manifest?.tileId) {
    return deepCopy(this.native.nativeFinanceProfile ?? {
      tileRevenueProfile: { schemaVersion: 3, tileId, calculatedAtSeconds: this.native.clock, hourly: Array.from({ length: 24 }, () => ({ revenue: 0, revenueByRoute: {} })), transitPopulation: 0, dailyRevenue: 0 },
      expenseProfile: { schemaVersion: 2, calculatedAtSeconds: this.native.clock, routeHourly: {}, infrastructureItems: [] },
    });
  }
  async postBackgroundNativeFinance(posting) {
    await this.#at('postBackgroundNativeFinance');
    const receipts = this.native.financialHistory.openWorldBackgroundFinanceReceipts ?? [];
    if (receipts.includes(posting.postingId)) {
      return { applied: false, wallet: this.native.wallet, financialHistory: deepCopy(this.native.financialHistory) };
    }
    const revenue = Number(posting.revenue) || 0;
    const expenses = Object.values(posting.expenseCategories ?? {}).reduce((sum, amount) => sum + (Number(amount) || 0), 0);
    const openingWallet = this.native.wallet;
    const targetElapsedSeconds = Number(posting.targetElapsedSeconds) || 0;
    const hourlyPostings = Array.isArray(posting.hourlyPostings) && posting.hourlyPostings.length
      ? posting.hourlyPostings
      : [{
        hour: Math.floor(Math.max(0, targetElapsedSeconds) / 3_600),
        revenue,
        expenses,
        expenseCategories: posting.expenseCategories,
        revenueByRoute: posting.revenueByRoute,
        expensesByRoute: posting.expensesByRoute,
      }];
    this.native.wallet += revenue - expenses;
    this.native.financialHistory = backfillHourlyFinancialHistory(
      this.native.financialHistory,
      hourlyPostings,
      { targetElapsedSeconds, openingWallet, receiptId: posting.postingId },
    );
    this.native.routeFinancials = backfillHourlyRouteFinancials(
      this.native.routeFinancials,
      hourlyPostings,
      targetElapsedSeconds,
    );
    for (const [routeId, amount] of Object.entries(posting.revenueByRoute ?? {})) {
      this.native.routeRevenueByRoute[routeId] = (this.native.routeRevenueByRoute[routeId] ?? 0) + amount;
    }
    this.native.routeExpensesByRoute ??= {};
    for (const [routeId, amount] of Object.entries(posting.expensesByRoute ?? {})) {
      this.native.routeExpensesByRoute[routeId] = (this.native.routeExpensesByRoute[routeId] ?? 0) + amount;
    }
    return { applied: true, revenue, expenses, wallet: this.native.wallet, financialHistory: deepCopy(this.native.financialHistory) };
  }
  captureCrossTileNetworkProfile(tileId = this.currentPackage?.manifest?.tileId) {
    return deepCopy(this.native.networkProfile ?? { schemaVersion: 1, tileId, signature: `${tileId}:empty`, stations: [], routes: [], activeRouteIds: [], pathfindingRules: {} });
  }
  async validateSnapshot(snapshot) {
    await this.#at('validateSnapshot');
    if (!snapshot?.objects || ('wallet' in snapshot && !Number.isFinite(snapshot.wallet))) {
      throw new Error('Invalid native snapshot');
    }
  }
  async reconcileActiveResults() { await this.#at('reconcileActiveResults'); const result = deepCopy(this.native.activity); this.native.activity = { departures: [], walletDelta: 0 }; return result; }
  async adoptStaticPackage(pkg, loadedTileId) {
    await this.#at('adoptStaticPackage');
    if (!pkg?.manifest || pkg.manifest.tileId !== loadedTileId) throw new Error('Loaded tile/package mismatch');
    this.currentPackage = deepCopy(pkg);
  }
  async loadStaticPackage(pkg) { await this.#at('loadStaticPackage'); if (!pkg?.manifest) throw new Error('Missing package manifest'); this.currentPackage = deepCopy(pkg); }
  async restoreSnapshot(snapshot, {
    preserveNativeFinance = false,
    authoritativeFinanceSnapshot = null,
  } = {}) {
    await this.#at('restoreSnapshot');
    const financialState = authoritativeFinanceSnapshot?.data
      ?? authoritativeFinanceSnapshot
      ?? this.native;
    const ledger = preserveNativeFinance ? Object.fromEntries([
      'gameMode', 'wallet', 'money', 'transitCost', 'fareGroups',
      'financialHistory', 'routeFinancials', 'bonds', 'hasGoneBankrupt',
      'rockefellerPaidOut', 'buildingDemolitionSpendAllTime',
    ].flatMap((key) => {
      const value = financialState?.[key] !== undefined
        ? financialState[key]
        : this.native?.[key];
      return value === undefined ? [] : [[key, deepCopy(value)]];
    })) : null;
    this.native = deepCopy(snapshot);
    if (ledger) Object.assign(this.native, ledger);
  }
  mergeSharedTransitNetwork(destinationSnapshot, sourceSnapshot) {
    return mergeSharedTransitNetworkState(destinationSnapshot, sourceSnapshot);
  }
  async setAuthoritativeGameMode(gameMode) { await this.#at('setAuthoritativeGameMode'); if (gameMode == null) return false; this.native.gameMode = gameMode; if (gameMode === 'sandbox') this.native.wallet = Number.MAX_SAFE_INTEGER; return true; }
  async setAuthoritativeClock(elapsedSeconds) { await this.#at('setAuthoritativeClock'); if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error('Invalid authoritative game time'); this.native.clock = Math.round(elapsedSeconds); }
  async setAuthoritativeGlobals({ worldTime, elapsedSeconds = worldTime * 3600, wallet, gameMode = null, farePolicy, financialHistory }) { await this.#at('setAuthoritativeGlobals'); this.native.clock = elapsedSeconds; await this.setAuthoritativeGameMode(gameMode); this.native.wallet = wallet; this.native.transitCost = farePolicy?.fare ?? this.native.transitCost; if (financialHistory) this.native.financialHistory = deepCopy(financialHistory); }
  async restoreCamera(camera) { await this.#at('restoreCamera'); if (camera) this.native.camera = deepCopy(camera); }
  async verifyLoaded() { await this.#at('verifyLoaded'); if (!this.currentPackage || !this.paused) throw new Error('Game was not quiesced/loaded'); }
  async captureRuntime() { return { native: deepCopy(this.native), package: deepCopy(this.currentPackage), paused: this.paused }; }
  async restoreRuntime(runtime) { this.native = deepCopy(runtime.native); this.currentPackage = deepCopy(runtime.package); this.paused = runtime.paused; }
  queueActivity(activity) { this.native.activity.departures.push(...(activity.departures ?? [])); this.native.activity.walletDelta += activity.walletDelta ?? 0; }
}
