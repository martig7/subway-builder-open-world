/** Disposable index over the native completed-commute array. Native records
 * and receipts remain authoritative; replacement, append or rewind rebuilds it.
 * Records in an owned published array are immutable, as in the native setter. */
export class NativeCommuteIndex {
  #source = null;
  #length = 0;
  #session = null;
  #time = null;
  #rows = new Map();
  #buckets = new Map();
  #ids = new Map();
  #sequence = 0;

  #insert(record) {
    const key = this.#sequence++;
    const id = record?.popId;
    const end = Number(record?.journeyEnd);
    const bucket = Number.isFinite(end) ? Math.floor(end / 3600) : null;
    const entry = { record, id, end, bucket };
    this.#rows.set(key, entry);
    if (!this.#buckets.has(bucket)) this.#buckets.set(bucket, new Set());
    this.#buckets.get(bucket).add(key);
    this.#ids.set(id, (this.#ids.get(id) ?? 0) + 1);
  }

  merge({ records = [], sessionId, elapsedSeconds, incoming = [], retainSince, transform = value => value }) {
    if (this.#source !== records || this.#length !== records.length
      || this.#session !== sessionId || elapsedSeconds < this.#time) {
      this.#rows.clear(); this.#buckets.clear(); this.#ids.clear(); this.#sequence = 0;
      for (const record of records) this.#insert(record);
    }
    // A failed transform/publication leaves a different native source on the
    // next call, forcing a rebuild instead of committing speculative IDs.
    this.#source = null;
    let expired = 0;
    if (Number.isFinite(retainSince)) {
      const cutoffBucket = Math.floor(retainSince / 3600);
      for (const [bucket, keys] of this.#buckets) {
        if (bucket !== null && bucket > cutoffBucket) continue;
        for (const key of keys) {
          const entry = this.#rows.get(key);
          if (entry.end >= retainSince) continue;
          keys.delete(key); this.#rows.delete(key); expired++;
          const count = this.#ids.get(entry.id) - 1;
          if (count) this.#ids.set(entry.id, count); else this.#ids.delete(entry.id);
        }
        if (!keys.size) this.#buckets.delete(bucket);
      }
    }
    const fresh = [];
    for (const record of incoming) {
      if (this.#ids.has(record.popId)) continue;
      const next = transform(record);
      // Match the native retention predicate, including missing/NaN ends.
      if (Number.isFinite(retainSince) && !(next.journeyEnd >= retainSince)) continue;
      this.#insert(next); fresh.push(next);
    }
    const output = expired ? Array.from(this.#rows.values(), entry => entry.record)
      : fresh.length ? [...records, ...fresh] : records;
    this.#source = output; this.#length = output.length;
    this.#session = sessionId; this.#time = elapsedSeconds;
    return { records: output, fresh, expired };
  }
}
