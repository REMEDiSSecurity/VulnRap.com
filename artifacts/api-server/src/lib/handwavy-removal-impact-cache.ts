// Server-side cache for the single-phrase removal-impact dry-run
// (`DELETE /feedback/calibration/handwavy-phrases` `{dryRun: true}`).
// The matching client-side cache lives in
// `vulnrap/src/pages/feedback-analytics.tsx`; the version-key contract
// here mirrors `computeHandwavyActiveListVersion` there so the two layers
// agree on when an entry is stale.
//
// Task #501 — sibling cache for the BULK dry-run path
// (`{phrases: [...], dryRun: true}`). Same TTL/invalidation contract as
// the single-phrase cache; keyed by the SORTED set of normalized phrases
// plus `(productionScanLimit, activeListVersion)` so a reviewer ticking
// and unticking phrases in the bulk-retire UI sees instant replay for any
// combination they revisit instead of re-paying the curated + production
// scan on every keystroke.

const REMOVAL_IMPACT_CACHE_MAX_ENTRIES = 64;

// Cached single-phrase dry-run response, minus the `cacheHit` / `cachedAt`
// metadata that the route layer attaches at serialization time. Typed
// loosely as a record so the route owns the authoritative response shape.
export type CachedRemovalImpactResponse = Record<string, unknown>;

export interface CachedRemovalImpactEntry {
  cachedAt: string;
  version: string;
  response: CachedRemovalImpactResponse;
}

export interface RemovalImpactCache {
  get(
    phrase: string,
    productionScanLimit: number,
    version: string,
  ): CachedRemovalImpactEntry | undefined;
  set(
    phrase: string,
    productionScanLimit: number,
    version: string,
    response: CachedRemovalImpactResponse,
    now?: string,
  ): void;
  invalidate(): void;
  size(): number;
}

export function createRemovalImpactCache(): RemovalImpactCache {
  // NUL byte separator can't appear in a normalized phrase, so the
  // `(productionScanLimit, phrase)` pair always hashes to one key.
  const cacheKey = (phrase: string, productionScanLimit: number): string =>
    `${productionScanLimit}\u0001${phrase}`;
  const store = new Map<string, CachedRemovalImpactEntry>();
  return {
    get(phrase, productionScanLimit, version) {
      const key = cacheKey(phrase, productionScanLimit);
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.version !== version) {
        store.delete(key);
        return undefined;
      }
      // LRU touch.
      store.delete(key);
      store.set(key, entry);
      return entry;
    },
    set(phrase, productionScanLimit, version, response, now) {
      const key = cacheKey(phrase, productionScanLimit);
      store.delete(key);
      store.set(key, {
        cachedAt: now ?? new Date().toISOString(),
        version,
        response,
      });
      while (store.size > REMOVAL_IMPACT_CACHE_MAX_ENTRIES) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    invalidate() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}

// Stable version string for the active phrase set. Sorted so a UI re-order
// alone doesn't pointlessly evict cached previews; JSON-encoded so two
// distinct lists can't collide on the same string regardless of which
// characters the phrases contain.
export function computeHandwavyActiveListVersion(
  phrases: ReadonlyArray<{ phrase: string }>,
): string {
  const sorted = phrases.map((p) => p.phrase).slice().sort();
  return JSON.stringify(sorted);
}

export const handwavyRemovalImpactCache = createRemovalImpactCache();

// Task #501 — sibling cache for the bulk dry-run path. Keyed by the SORTED
// list of normalized phrases (so the cache is order-insensitive but
// duplicate-sensitive — `["foo","foo"]` reports a different
// `duplicateInBatch` count than `["foo"]`, so it must hash to a distinct
// key) plus `(productionScanLimit, activeListVersion)`. The shape of the
// cache itself is identical to the single-phrase cache.
export interface BulkRemovalImpactCache {
  get(
    phrases: ReadonlyArray<string>,
    productionScanLimit: number,
    version: string,
  ): CachedRemovalImpactEntry | undefined;
  set(
    phrases: ReadonlyArray<string>,
    productionScanLimit: number,
    version: string,
    response: CachedRemovalImpactResponse,
    now?: string,
  ): void;
  invalidate(): void;
  size(): number;
}

export function createBulkRemovalImpactCache(): BulkRemovalImpactCache {
  // Sort so a UI re-order alone doesn't pointlessly miss the cache;
  // JSON-encode the list so two distinct phrase sets can never collide on
  // the same key string regardless of which characters appear in any
  // individual phrase. NUL byte separator can't appear in the JSON
  // encoding so the `(productionScanLimit, phrases)` pair always hashes
  // to one key.
  const cacheKey = (
    phrases: ReadonlyArray<string>,
    productionScanLimit: number,
  ): string => {
    const sorted = phrases.slice().sort();
    return `${productionScanLimit}\u0001${JSON.stringify(sorted)}`;
  };
  const store = new Map<string, CachedRemovalImpactEntry>();
  return {
    get(phrases, productionScanLimit, version) {
      const key = cacheKey(phrases, productionScanLimit);
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.version !== version) {
        store.delete(key);
        return undefined;
      }
      // LRU touch.
      store.delete(key);
      store.set(key, entry);
      return entry;
    },
    set(phrases, productionScanLimit, version, response, now) {
      const key = cacheKey(phrases, productionScanLimit);
      store.delete(key);
      store.set(key, {
        cachedAt: now ?? new Date().toISOString(),
        version,
        response,
      });
      while (store.size > REMOVAL_IMPACT_CACHE_MAX_ENTRIES) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    invalidate() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}

export const handwavyBulkRemovalImpactCache = createBulkRemovalImpactCache();
