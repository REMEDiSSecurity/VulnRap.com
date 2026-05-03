// Task #378 — unit tests for the persisted dataset-history compaction-
// window config. Mirrors archetype-history-config.test.ts so the two
// reviewer knobs share the same coverage shape.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompactWindowValidationError,
  DEFAULT_COMPACT_AFTER_DAYS,
  MAX_COMPACT_AFTER_DAYS,
  MIN_COMPACT_AFTER_DAYS,
  __testing,
  clearPersistedCompactAfterDays,
  getCompactAfterDaysSetting,
  getEffectiveCompactAfterDays,
  setPersistedCompactAfterDays,
} from "./dataset-history-config";

describe("dataset-history-config", () => {
  let tmpDir: string;
  let prevCfgPath: string | undefined;
  let prevEnvDays: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dataset-history-cfg-"));
    prevCfgPath = process.env.DATASET_HISTORY_CONFIG_PATH;
    prevEnvDays = process.env.DATASET_HISTORY_COMPACT_DAYS;
    process.env.DATASET_HISTORY_CONFIG_PATH = path.join(tmpDir, "cfg.json");
    delete process.env.DATASET_HISTORY_COMPACT_DAYS;
    __testing.resetCache();
  });

  afterEach(async () => {
    if (prevCfgPath === undefined)
      delete process.env.DATASET_HISTORY_CONFIG_PATH;
    else process.env.DATASET_HISTORY_CONFIG_PATH = prevCfgPath;
    if (prevEnvDays === undefined)
      delete process.env.DATASET_HISTORY_COMPACT_DAYS;
    else process.env.DATASET_HISTORY_COMPACT_DAYS = prevEnvDays;
    await fs.rm(tmpDir, { recursive: true, force: true });
    __testing.resetCache();
  });

  it("falls back to the built-in default when neither env nor file is set", () => {
    const setting = getCompactAfterDaysSetting();
    expect(setting.effectiveDays).toBe(DEFAULT_COMPACT_AFTER_DAYS);
    expect(setting.source).toBe("default");
    expect(setting.envOverride).toBeNull();
    expect(setting.persistedDays).toBeNull();
    expect(setting.min).toBe(MIN_COMPACT_AFTER_DAYS);
    expect(setting.max).toBe(MAX_COMPACT_AFTER_DAYS);
  });

  it("persists a reviewer-supplied window and reads it back across cache resets", async () => {
    const after = await setPersistedCompactAfterDays(60);
    expect(after.effectiveDays).toBe(60);
    expect(after.source).toBe("persisted");
    expect(after.persistedDays).toBe(60);

    __testing.resetCache();
    const reread = getCompactAfterDaysSetting();
    expect(reread.effectiveDays).toBe(60);
    expect(reread.source).toBe("persisted");
  });

  it("lets the env var override any persisted value", async () => {
    await setPersistedCompactAfterDays(60);
    process.env.DATASET_HISTORY_COMPACT_DAYS = "14";
    const setting = getCompactAfterDaysSetting();
    expect(setting.effectiveDays).toBe(14);
    expect(setting.source).toBe("env");
    expect(setting.envOverride).toBe(14);
    expect(setting.persistedDays).toBe(60);
  });

  it("rejects values outside the allowed bounds", async () => {
    await expect(setPersistedCompactAfterDays(0)).rejects.toBeInstanceOf(
      CompactWindowValidationError,
    );
    await expect(
      setPersistedCompactAfterDays(MIN_COMPACT_AFTER_DAYS - 1),
    ).rejects.toBeInstanceOf(CompactWindowValidationError);
    await expect(
      setPersistedCompactAfterDays(MAX_COMPACT_AFTER_DAYS + 1),
    ).rejects.toBeInstanceOf(CompactWindowValidationError);
    await expect(setPersistedCompactAfterDays("nope")).rejects.toBeInstanceOf(
      CompactWindowValidationError,
    );
    await expect(setPersistedCompactAfterDays(30.5)).rejects.toBeInstanceOf(
      CompactWindowValidationError,
    );
  });

  it("accepts numeric strings within bounds and stores the rounded value", async () => {
    const after = await setPersistedCompactAfterDays("90");
    expect(after.persistedDays).toBe(90);
    expect(after.effectiveDays).toBe(90);
  });

  it("clearPersistedCompactAfterDays drops the persisted setting", async () => {
    await setPersistedCompactAfterDays(45);
    expect(getEffectiveCompactAfterDays()).toBe(45);
    const cleared = await clearPersistedCompactAfterDays();
    expect(cleared.persistedDays).toBeNull();
    expect(cleared.source).toBe("default");
    expect(cleared.effectiveDays).toBe(DEFAULT_COMPACT_AFTER_DAYS);
  });

  it("ignores out-of-range persisted files (treats as no setting)", async () => {
    const cfgPath = process.env.DATASET_HISTORY_CONFIG_PATH!;
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(
      cfgPath,
      JSON.stringify({ version: 1, compactAfterDays: 9999 }),
      "utf-8",
    );
    __testing.resetCache();
    const setting = getCompactAfterDaysSetting();
    expect(setting.persistedDays).toBeNull();
    expect(setting.source).toBe("default");
  });
});
