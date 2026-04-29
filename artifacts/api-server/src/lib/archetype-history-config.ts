// Task #99 — reviewer-tunable compaction window for archetype history.
//
// The compaction window (how many days of raw per-run snapshots to keep
// before they get rolled up into one row per UTC day, archetype) was
// previously controlled only by the ARCHETYPE_HISTORY_COMPACT_DAYS env
// var. That meant tuning it required a redeploy, even though it's a
// pure trend-resolution / storage tradeoff that the calibration
// reviewer is best positioned to make as the dataset grows.
//
// This module introduces a small persisted JSON config that the
// calibration dashboard can read and update via /api/test/archetype-history/config.
// Resolution order for the effective window:
//   1. ARCHETYPE_HISTORY_COMPACT_DAYS env var (when set to a positive
//      finite number) — wins so deploy-time policy still overrides any
//      reviewer setting.
//   2. The persisted JSON config (when present and within bounds).
//   3. The built-in default (30 days).
// The dashboard surfaces all three so reviewers can see why the
// effective window is what it is and whether their setting will take
// effect.
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";

export const DEFAULT_COMPACT_AFTER_DAYS = 30;
export const MIN_COMPACT_AFTER_DAYS = 7;
export const MAX_COMPACT_AFTER_DAYS = 365;

const DEFAULT_CONFIG_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/archetype-history-config.json",
);

interface PersistedConfig {
  version: 1;
  compactAfterDays: number;
}

export type CompactWindowSource = "env" | "persisted" | "default";

export interface EffectiveCompactWindow {
  effectiveDays: number;
  source: CompactWindowSource;
  envOverride: number | null;
  persistedDays: number | null;
  defaultDays: number;
  min: number;
  max: number;
}

function configPath(): string {
  return process.env.ARCHETYPE_HISTORY_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

// Cached so compactAfterDays() (called on every appendArchetypeSnapshots)
// stays cheap. The cache is keyed by path so a test that overrides
// ARCHETYPE_HISTORY_CONFIG_PATH cannot read another test's value.
let cachedPersisted: number | null | undefined; // undefined = unloaded
let cachedFromPath: string | null = null;

function isValidPersistedDays(n: unknown): n is number {
  if (typeof n !== "number") return false;
  if (!Number.isFinite(n)) return false;
  return n >= MIN_COMPACT_AFTER_DAYS && n <= MAX_COMPACT_AFTER_DAYS;
}

function loadPersistedSync(): number | null {
  const p = configPath();
  if (cachedPersisted !== undefined && cachedFromPath === p) {
    return cachedPersisted;
  }
  try {
    const raw = fsSync.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
    const n = Number(parsed?.compactAfterDays);
    cachedPersisted = isValidPersistedDays(n) ? Math.round(n) : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        `[archetype-history-config] failed to read ${p} (${code ?? (err as Error)?.message ?? "unknown"}); ignoring persisted compaction window`,
      );
    }
    cachedPersisted = null;
  }
  cachedFromPath = p;
  return cachedPersisted;
}

function envOverride(): number | null {
  const raw = process.env.ARCHETYPE_HISTORY_COMPACT_DAYS;
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function getCompactAfterDaysSetting(): EffectiveCompactWindow {
  const env = envOverride();
  const persisted = loadPersistedSync();
  let effectiveDays = DEFAULT_COMPACT_AFTER_DAYS;
  let source: CompactWindowSource = "default";
  if (env != null) {
    effectiveDays = env;
    source = "env";
  } else if (persisted != null) {
    effectiveDays = persisted;
    source = "persisted";
  }
  return {
    effectiveDays,
    source,
    envOverride: env,
    persistedDays: persisted,
    defaultDays: DEFAULT_COMPACT_AFTER_DAYS,
    min: MIN_COMPACT_AFTER_DAYS,
    max: MAX_COMPACT_AFTER_DAYS,
  };
}

export function getEffectiveCompactAfterDays(): number {
  return getCompactAfterDaysSetting().effectiveDays;
}

export class CompactWindowValidationError extends Error {
  readonly status: number;
  constructor(reason: string, status = 400) {
    super(reason);
    this.name = "CompactWindowValidationError";
    this.status = status;
  }
}

function coerceDays(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim().length > 0) return Number(raw);
  return Number.NaN;
}

export async function setPersistedCompactAfterDays(
  daysRaw: unknown,
): Promise<EffectiveCompactWindow> {
  const n = coerceDays(daysRaw);
  if (!Number.isFinite(n)) {
    throw new CompactWindowValidationError(
      `compactAfterDays must be a number (got ${JSON.stringify(daysRaw)}).`,
    );
  }
  if (!Number.isInteger(n)) {
    throw new CompactWindowValidationError(
      `compactAfterDays must be a whole number of days (got ${n}).`,
    );
  }
  if (n < MIN_COMPACT_AFTER_DAYS || n > MAX_COMPACT_AFTER_DAYS) {
    throw new CompactWindowValidationError(
      `compactAfterDays must be between ${MIN_COMPACT_AFTER_DAYS} and ${MAX_COMPACT_AFTER_DAYS} days (got ${n}).`,
    );
  }
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const file: PersistedConfig = { version: 1, compactAfterDays: n };
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmp, p);
  cachedPersisted = n;
  cachedFromPath = p;
  return getCompactAfterDaysSetting();
}

export async function clearPersistedCompactAfterDays(): Promise<EffectiveCompactWindow> {
  const p = configPath();
  try {
    await fs.unlink(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw err;
  }
  cachedPersisted = null;
  cachedFromPath = p;
  return getCompactAfterDaysSetting();
}

export const __testing = {
  configPath,
  resetCache: () => {
    cachedPersisted = undefined;
    cachedFromPath = null;
  },
};
