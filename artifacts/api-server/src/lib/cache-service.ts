import { db, apiCacheTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";

export type TtlCategory = "immutable" | "mutable" | "nvd";

const TTL_MS: Record<TtlCategory, number> = {
  immutable: 7 * 24 * 60 * 60 * 1000,
  mutable: 60 * 60 * 1000,
  nvd: 24 * 60 * 60 * 1000,
};

interface L1Entry<T> {
  value: T;
  ts: number;
}

const l1Cache = new Map<string, L1Entry<unknown>>();
const L1_TTL_MS = 5 * 60 * 1000;
const L1_MAX_SIZE = 500;

function l1Get<T>(key: string): T | undefined {
  const entry = l1Cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > L1_TTL_MS) {
    l1Cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function l1Set<T>(key: string, value: T): void {
  l1Cache.set(key, { value, ts: Date.now() });
  if (l1Cache.size > L1_MAX_SIZE) {
    const oldest = [...l1Cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 100; i++) l1Cache.delete(oldest[i][0]);
  }
}

export interface CacheResult<T> {
  value: T;
  source: "l1" | "db" | "fresh";
}

export async function persistentCacheGet<T>(key: string): Promise<CacheResult<T> | undefined> {
  const l1 = l1Get<T>(key);
  if (l1 !== undefined) {
    return { value: l1, source: "l1" };
  }

  try {
    const rows = await db
      .select()
      .from(apiCacheTable)
      .where(eq(apiCacheTable.cacheKey, key))
      .limit(1);

    if (rows.length === 0) return undefined;

    const row = rows[0];
    if (new Date(row.expiresAt) < new Date()) {
      db.delete(apiCacheTable).where(eq(apiCacheTable.cacheKey, key)).catch(() => {});
      return undefined;
    }

    const value = row.responseData as T;
    l1Set(key, value);
    return { value, source: "db" };
  } catch {
    return undefined;
  }
}

export async function persistentCacheSet<T>(key: string, value: T, category: TtlCategory): Promise<void> {
  l1Set(key, value);

  const ttlMs = TTL_MS[category];
  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    await db
      .insert(apiCacheTable)
      .values({
        cacheKey: key,
        responseData: value as unknown as Record<string, unknown>,
        ttlCategory: category,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: apiCacheTable.cacheKey,
        set: {
          responseData: value as unknown as Record<string, unknown>,
          ttlCategory: category,
          expiresAt,
          createdAt: new Date(),
        },
      });
  } catch {
  }
}

export async function cleanExpiredCache(): Promise<number> {
  try {
    const result = await db
      .delete(apiCacheTable)
      .where(lt(apiCacheTable.expiresAt, new Date()));
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  } catch {
    return 0;
  }
}
