// Task #1335 — Keep the NVD-rejected CVE list fresh automatically.
//
// Background. The CVE-validation pre-filter (`lib/pre-filters/cve-validation.ts`)
// ships with an in-process Map<cveId, status> behind a 7-day TTL. That cache
// is the only thing that lets `rejected_cve` fire on rr-153 in the corpus —
// the format/future-year checks already handle rr-149/150/152 on their own.
// Until now nothing was actually populating the map, so the REJECT lane was
// dark in production and `rr-153` always landed as a MISS in the pre-filter
// smoke.
//
// This module closes that gap in two pieces:
//
//   1. A periodic refresher (`startNvdRejectedFeedScheduler`) that pulls the
//      NVD "Rejected" feed in pages of 2000 and calls `primeNvdCache` for
//      every CVE id it sees. The default cadence is 6h, comfortably inside
//      the pre-filter's 7-day TTL so a hot replica never sees the cache go
//      cold between ticks.
//
//   2. A disk-backed mirror of the rejected set. The pre-filter's Map is
//      per-process by design, so a fresh replica boot would otherwise have
//      to wait for the first scheduler tick before `rejected_cve` could
//      fire. We write `{ cves: [...], fetchedAt }` to a JSON file on every
//      successful tick and re-load it on boot (and from the smoke harness),
//      so quarantine coverage survives restarts and deploys.
//
// Env knobs (all optional; sane defaults baked in):
//   NVD_REJECTED_FEED_ENABLED         — "1"/"true" to enable the scheduler
//                                       in this replica. Defaults to off so
//                                       unit tests and dev boots don't make
//                                       network calls. Production flips it
//                                       on; the loader still runs regardless
//                                       (it's a local-disk read).
//   NVD_REJECTED_FEED_INTERVAL_MS     — success cadence (default 6h).
//   NVD_REJECTED_FEED_RETRY_INTERVAL_MS — failure retry (default 15min).
//   NVD_REJECTED_FEED_INITIAL_DELAY_MS — first-tick delay (default 30s).
//   NVD_REJECTED_FEED_PAGE_SIZE       — page size for the NVD query
//                                       (default 2000, the NVD API cap).
//   NVD_REJECTED_FEED_MAX_PAGES       — page cap per tick (default 20).
//   NVD_REJECTED_CACHE_PATH           — disk persistence path (default
//                                       `.cache/nvd-rejected.json` under cwd).
//   NVD_API_KEY                       — optional NVD API key; raises the
//                                       rate limit from 5 → 50 req/30s and
//                                       is forwarded as `apiKey` header.

import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { httpFetch } from "./http-client";
import { primeNvdCache } from "./pre-filters/cve-validation";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;
const DEFAULT_PAGE_SIZE = 2000;
// The NVD CVE 2.0 API has no server-side "rejected only" filter — the
// `noRejected` param is binary include/exclude, not a status filter. We
// therefore page the *entire* CVE corpus and keep rows where
// `vulnStatus === "Rejected"` client-side. The corpus is ~300K CVEs as
// of 2026, so 500 pages × 2000 results = 1,000,000 result slots is a
// comfortable ceiling. The runtime cap is *not* used to silently truncate
// the feed — if `totalResults` ever exceeds `maxPages * pageSize` the
// fetcher throws so the scheduler re-arms at the retry cadence and
// leaves the previous (complete) persisted cache untouched.
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_CACHE_PATH = ".cache/nvd-rejected.json";

const NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";

interface PersistedRejectedCache {
  cves: string[];
  fetchedAt: string;
}

function isEnabled(): boolean {
  const raw = (process.env.NVD_REJECTED_FEED_ENABLED ?? "").trim();
  return raw === "1" || raw.toLowerCase() === "true";
}

function parseIntegerEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function autoIntervalMs(): number {
  return parseIntegerEnv(
    process.env.NVD_REJECTED_FEED_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
  );
}
function autoRetryIntervalMs(): number {
  return parseIntegerEnv(
    process.env.NVD_REJECTED_FEED_RETRY_INTERVAL_MS,
    DEFAULT_RETRY_INTERVAL_MS,
  );
}
function autoInitialDelayMs(): number {
  return parseIntegerEnv(
    process.env.NVD_REJECTED_FEED_INITIAL_DELAY_MS,
    DEFAULT_INITIAL_DELAY_MS,
  );
}
function autoPageSize(): number {
  return parseIntegerEnv(
    process.env.NVD_REJECTED_FEED_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );
}
function autoMaxPages(): number {
  return parseIntegerEnv(
    process.env.NVD_REJECTED_FEED_MAX_PAGES,
    DEFAULT_MAX_PAGES,
  );
}
export function getCachePath(): string {
  const raw = (process.env.NVD_REJECTED_CACHE_PATH ?? "").trim();
  return raw.length > 0
    ? raw
    : path.resolve(process.cwd(), DEFAULT_CACHE_PATH);
}

// --- Disk persistence -----------------------------------------------------

/**
 * Read the persisted rejected-CVE list and prime the in-process pre-filter
 * cache. Returns the number of entries primed (0 when the file is missing,
 * unreadable, or malformed — all non-fatal). Safe to call from boot and
 * from the smoke harness; both lean on the same on-disk artifact.
 */
export async function loadPersistedNvdRejectedCache(
  filePath: string = getCachePath(),
): Promise<{ loaded: number; fetchedAt: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { loaded: 0, fetchedAt: null };
    }
    logger.warn(
      { err, filePath },
      "[nvd-rejected-feed] failed to read persisted cache (non-fatal)",
    );
    return { loaded: 0, fetchedAt: null };
  }
  let parsed: PersistedRejectedCache;
  try {
    parsed = JSON.parse(raw) as PersistedRejectedCache;
  } catch (err) {
    logger.warn(
      { err, filePath },
      "[nvd-rejected-feed] persisted cache is not valid JSON (non-fatal)",
    );
    return { loaded: 0, fetchedAt: null };
  }
  if (!parsed || !Array.isArray(parsed.cves)) {
    return { loaded: 0, fetchedAt: null };
  }
  let loaded = 0;
  for (const id of parsed.cves) {
    if (typeof id === "string" && id.length > 0) {
      primeNvdCache(id, "REJECT");
      loaded += 1;
    }
  }
  return {
    loaded,
    fetchedAt: typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : null,
  };
}

async function writePersistedRejectedCache(
  filePath: string,
  cves: string[],
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const payload: PersistedRejectedCache = {
    cves,
    fetchedAt: new Date().toISOString(),
  };
  // Write to a sibling tempfile and rename so a crashed write can never
  // leave a half-flushed JSON on disk that breaks the next boot's loader.
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(payload) + "\n");
  await fs.rename(tmp, filePath);
}

// --- NVD fetcher ----------------------------------------------------------

interface NvdCveItem {
  cve?: { id?: string; vulnStatus?: string };
}
interface NvdCveResponse {
  vulnerabilities?: NvdCveItem[];
  totalResults?: number;
  startIndex?: number;
  resultsPerPage?: number;
}

/**
 * Fetch every rejected CVE from NVD, paging through up to `maxPages` pages
 * of `pageSize` results. Returns the full set as a sorted, de-duplicated
 * array.
 *
 * NVD has no server-side rejected-only filter, so we page the full CVE
 * corpus and keep rows where `vulnStatus === "Rejected"` (the `noRejected`
 * param only flips inclusion, it isn't a status filter). This makes the
 * `maxPages` guard load-bearing: if the upstream `totalResults` ever
 * exceeds `maxPages * pageSize` we **throw** rather than return a
 * truncated set. The caller (`runNvdRejectedFeedTick`) treats throws as
 * a failed tick and re-arms at the retry cadence WITHOUT overwriting the
 * previously-persisted complete cache. Better to keep yesterday's full
 * snapshot than ship a silently-incomplete one.
 *
 * Other errors (upstream HTTP / network) also throw for the same reason.
 */
export async function fetchRejectedCveFeed(opts: {
  pageSize?: number;
  maxPages?: number;
  fetch?: typeof httpFetch;
} = {}): Promise<string[]> {
  const pageSize = opts.pageSize ?? autoPageSize();
  const maxPages = opts.maxPages ?? autoMaxPages();
  const fetchFn = opts.fetch ?? httpFetch;
  const apiKey = (process.env.NVD_API_KEY ?? "").trim();
  const headers: Record<string, string> = { "User-Agent": "VulnRap/2.1" };
  if (apiKey) headers["apiKey"] = apiKey;

  const seen = new Set<string>();
  let startIndex = 0;
  let totalResults = 0;
  let pagesFetched = 0;
  for (let page = 0; page < maxPages; page++) {
    const url =
      `${NVD_BASE_URL}?` +
      `resultsPerPage=${pageSize}&startIndex=${startIndex}` +
      `&noRejected=false`;
    const r = await fetchFn({
      provider: "nvd",
      url,
      init: { headers },
    });
    if (r.kind !== "ok") {
      throw new Error(
        `[nvd-rejected-feed] upstream ${r.kind} at startIndex=${startIndex}: ${r.kind === "error" ? `HTTP ${r.status}` : r.detail}`,
      );
    }
    const data = (await r.value.json()) as NvdCveResponse;
    const vulns = Array.isArray(data.vulnerabilities) ? data.vulnerabilities : [];
    for (const item of vulns) {
      const id = item.cve?.id;
      const status = (item.cve?.vulnStatus ?? "").toLowerCase();
      if (typeof id === "string" && id.startsWith("CVE-") && status === "rejected") {
        seen.add(id.toUpperCase());
      }
    }
    totalResults =
      typeof data.totalResults === "number" ? data.totalResults : 0;
    const advanced =
      typeof data.resultsPerPage === "number" && data.resultsPerPage > 0
        ? data.resultsPerPage
        : vulns.length;
    startIndex += advanced;
    pagesFetched += 1;
    if (advanced === 0 || startIndex >= totalResults) {
      return [...seen].sort();
    }
  }
  // We ran out of page budget before reaching totalResults. Refuse to
  // return a partial set — see header comment for the trade-off.
  throw new Error(
    `[nvd-rejected-feed] page cap exhausted before draining feed: ` +
      `pagesFetched=${pagesFetched} pageSize=${pageSize} ` +
      `scanned=${startIndex}/${totalResults}. Raise NVD_REJECTED_FEED_MAX_PAGES ` +
      `or NVD_REJECTED_FEED_PAGE_SIZE; refusing to overwrite cache with ` +
      `a truncated set.`,
  );
}

// --- Tick + scheduler -----------------------------------------------------

export interface RefreshTickResult {
  ok: boolean;
  ranTick: boolean;
  count?: number;
  durationMs?: number;
}

export async function runNvdRejectedFeedTick(opts: {
  fetch?: typeof httpFetch;
  cachePath?: string;
} = {}): Promise<RefreshTickResult> {
  if (!isEnabled()) {
    return { ok: true, ranTick: false };
  }
  const startedAt = Date.now();
  const cachePath = opts.cachePath ?? getCachePath();
  try {
    const cves = await fetchRejectedCveFeed({ fetch: opts.fetch });
    for (const id of cves) primeNvdCache(id, "REJECT");
    await writePersistedRejectedCache(cachePath, cves);
    const durationMs = Date.now() - startedAt;
    logger.info(
      { count: cves.length, durationMs, cachePath },
      "[nvd-rejected-feed] refreshed rejected-CVE cache",
    );
    return { ok: true, ranTick: true, count: cves.length, durationMs };
  } catch (err) {
    logger.warn(
      { err },
      "[nvd-rejected-feed] tick failed (non-fatal); will retry",
    );
    return { ok: false, ranTick: true };
  }
}

export interface NvdRejectedFeedSchedulerOptions {
  intervalMs?: number;
  retryIntervalMs?: number;
  initialDelayMs?: number;
  run?: () => Promise<RefreshTickResult>;
  /** Inject a loader for tests so we don't read the real disk path. */
  load?: () => Promise<{ loaded: number; fetchedAt: string | null }>;
}

export interface NvdRejectedFeedScheduler {
  stop(): void;
  ticksCompleted(): number;
}

export interface NvdRejectedFeedSchedulerStatus {
  schedulerStarted: boolean;
  schedulerEnabled: boolean;
  startedAt: string | null;
  intervalMs: number | null;
  retryIntervalMs: number | null;
  lastTickAt: string | null;
  lastTickOk: boolean | null;
  lastTickRanTick: boolean | null;
  lastTickCount: number | null;
  lastTickDurationMs: number | null;
  loadedFromDisk: number | null;
  loadedFetchedAt: string | null;
  nextTickAt: string | null;
  ticksCompleted: number;
}

const INITIAL_STATUS: NvdRejectedFeedSchedulerStatus = {
  schedulerStarted: false,
  schedulerEnabled: false,
  startedAt: null,
  intervalMs: null,
  retryIntervalMs: null,
  lastTickAt: null,
  lastTickOk: null,
  lastTickRanTick: null,
  lastTickCount: null,
  lastTickDurationMs: null,
  loadedFromDisk: null,
  loadedFetchedAt: null,
  nextTickAt: null,
  ticksCompleted: 0,
};

let schedulerStatus: NvdRejectedFeedSchedulerStatus = { ...INITIAL_STATUS };

export function getNvdRejectedFeedSchedulerStatus(): NvdRejectedFeedSchedulerStatus {
  return { ...schedulerStatus, schedulerEnabled: isEnabled() };
}

/**
 * Start the recurring NVD rejected-feed refresher. Call exactly once at
 * server boot. The first thing the scheduler does is read the persisted
 * cache so `rejected_cve` can fire from tick zero — only the periodic
 * fetch is gated on `NVD_REJECTED_FEED_ENABLED`.
 */
export function startNvdRejectedFeedScheduler(
  opts: NvdRejectedFeedSchedulerOptions = {},
): NvdRejectedFeedScheduler {
  const intervalMs = opts.intervalMs ?? autoIntervalMs();
  const retryIntervalMs = opts.retryIntervalMs ?? autoRetryIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? autoInitialDelayMs();
  const run = opts.run ?? (() => runNvdRejectedFeedTick());
  const load = opts.load ?? (() => loadPersistedNvdRejectedCache());

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let completed = 0;

  const startedAtMs = Date.now();
  schedulerStatus = {
    ...INITIAL_STATUS,
    schedulerStarted: true,
    schedulerEnabled: isEnabled(),
    startedAt: new Date(startedAtMs).toISOString(),
    intervalMs,
    retryIntervalMs,
    nextTickAt: new Date(startedAtMs + initialDelayMs).toISOString(),
  };

  // Fire-and-forget the persisted-cache load so quarantine coverage is
  // hot before the first network tick fires. We deliberately don't await
  // here — boot should not block on disk IO — but tests can inject a
  // synchronous loader to assert ordering.
  void load()
    .then((result) => {
      schedulerStatus = {
        ...schedulerStatus,
        loadedFromDisk: result.loaded,
        loadedFetchedAt: result.fetchedAt,
      };
      if (result.loaded > 0) {
        logger.info(
          { loaded: result.loaded, fetchedAt: result.fetchedAt },
          "[nvd-rejected-feed] primed cache from persisted file",
        );
      }
    })
    .catch((err) => {
      logger.warn(
        { err },
        "[nvd-rejected-feed] persisted-cache load failed (non-fatal)",
      );
    });

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    let ok = true;
    let ranTick: boolean | null = null;
    let count: number | null = null;
    let durationMs: number | null = null;
    try {
      const result = await run();
      ok = result.ok;
      ranTick = typeof result.ranTick === "boolean" ? result.ranTick : null;
      count = typeof result.count === "number" ? result.count : null;
      durationMs =
        typeof result.durationMs === "number" ? result.durationMs : null;
    } catch (err) {
      logger.warn(
        { err },
        "[nvd-rejected-feed] scheduler tick threw unexpectedly (non-fatal)",
      );
      ok = false;
    } finally {
      completed += 1;
      const completedAtMs = Date.now();
      const nextDelayMs = ok ? intervalMs : retryIntervalMs;
      schedulerStatus = {
        ...schedulerStatus,
        schedulerEnabled: isEnabled(),
        lastTickAt: new Date(completedAtMs).toISOString(),
        lastTickOk: ok,
        lastTickRanTick: ranTick,
        lastTickCount: count,
        lastTickDurationMs: durationMs,
        nextTickAt: stopped
          ? null
          : new Date(completedAtMs + nextDelayMs).toISOString(),
        ticksCompleted: completed,
      };
    }
    schedule(ok ? intervalMs : retryIntervalMs);
  }

  schedule(initialDelayMs);

  logger.info(
    { intervalMs, retryIntervalMs, initialDelayMs, enabled: isEnabled() },
    "[nvd-rejected-feed] scheduler started",
  );

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      schedulerStatus = { ...schedulerStatus, nextTickAt: null };
    },
    ticksCompleted: () => completed,
  };
}

export const __testing = {
  resetSchedulerStatus: () => {
    schedulerStatus = { ...INITIAL_STATUS };
  },
  isEnabled,
  autoIntervalMs,
  autoRetryIntervalMs,
  autoInitialDelayMs,
  autoPageSize,
  autoMaxPages,
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_INITIAL_DELAY_MS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_MAX_PAGES,
  DEFAULT_CACHE_PATH,
  NVD_BASE_URL,
  writePersistedRejectedCache,
};
