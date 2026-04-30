// Server-side cache for the single-phrase removal-impact dry-run
// (`DELETE /feedback/calibration/handwavy-phrases` `{dryRun: true}`).
// The matching client-side cache lives in
// `vulnrap/src/pages/feedback-analytics.tsx`; the version-key contract
// here mirrors `computeHandwavyActiveListVersion` there so the two layers
// agree on when an entry is stale.

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
