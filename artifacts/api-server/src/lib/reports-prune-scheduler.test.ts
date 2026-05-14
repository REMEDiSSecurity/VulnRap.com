import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readPruneConfig,
  runPruneTick,
  startReportsPruneScheduler,
} from "./reports-prune-scheduler";

describe("reports-prune-scheduler config", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("is disabled by default", () => {
    delete process.env.REPORTS_PRUNE_ENABLED;
    expect(readPruneConfig().enabled).toBe(false);
  });

  it("respects REPORTS_PRUNE_ENABLED truthy values", () => {
    process.env.REPORTS_PRUNE_ENABLED = "1";
    expect(readPruneConfig().enabled).toBe(true);
    process.env.REPORTS_PRUNE_ENABLED = "true";
    expect(readPruneConfig().enabled).toBe(true);
    process.env.REPORTS_PRUNE_ENABLED = "yes";
    expect(readPruneConfig().enabled).toBe(true);
    process.env.REPORTS_PRUNE_ENABLED = "no";
    expect(readPruneConfig().enabled).toBe(false);
  });

  it("dust pass is opt-in even when prune is enabled", () => {
    process.env.REPORTS_PRUNE_ENABLED = "1";
    delete process.env.REPORTS_PRUNE_DUST_ENABLED;
    expect(readPruneConfig().dustEnabled).toBe(false);
    process.env.REPORTS_PRUNE_DUST_ENABLED = "1";
    expect(readPruneConfig().dustEnabled).toBe(true);
  });

  it("uses safe defaults for retention windows", () => {
    process.env.REPORTS_PRUNE_ENABLED = "1";
    delete process.env.REPORTS_FAILED_MAX_RETRIES;
    delete process.env.REPORTS_ABANDONED_RETENTION_DAYS;
    delete process.env.REPORTS_DUST_COMPOSITE_THRESHOLD;
    delete process.env.REPORTS_DUST_RETENTION_DAYS;
    const cfg = readPruneConfig();
    expect(cfg.failedMaxRetries).toBe(3);
    expect(cfg.abandonedRetentionDays).toBe(7);
    expect(cfg.dustCompositeThreshold).toBe(25);
    expect(cfg.dustRetentionDays).toBe(30);
  });

  it("overrides defaults from env", () => {
    process.env.REPORTS_PRUNE_ENABLED = "1";
    process.env.REPORTS_FAILED_MAX_RETRIES = "5";
    process.env.REPORTS_ABANDONED_RETENTION_DAYS = "14";
    process.env.REPORTS_DUST_COMPOSITE_THRESHOLD = "20";
    process.env.REPORTS_DUST_RETENTION_DAYS = "60";
    const cfg = readPruneConfig();
    expect(cfg.failedMaxRetries).toBe(5);
    expect(cfg.abandonedRetentionDays).toBe(14);
    expect(cfg.dustCompositeThreshold).toBe(20);
    expect(cfg.dustRetentionDays).toBe(60);
  });
});

describe("runPruneTick", () => {
  it("short-circuits when disabled (no DB import)", async () => {
    const result = await runPruneTick({
      enabled: false,
      dustEnabled: false,
      tickIntervalMs: 1,
      initialDelayMs: 1,
      failedMaxRetries: 3,
      failedQuarantineHours: 24,
      abandonedRetentionDays: 7,
      dustCompositeThreshold: 25,
      dustRetentionDays: 30,
    });
    expect(result.ranTick).toBe(false);
    expect(result.abandonedMarked).toBe(0);
    expect(result.abandonedDeleted).toBe(0);
    expect(result.dustDeleted).toBe(0);
  });
});

describe("startReportsPruneScheduler", () => {
  it("does not arm a timer when disabled", () => {
    const setSpy = vi.spyOn(global, "setTimeout");
    const handle = startReportsPruneScheduler({
      enabled: false,
      dustEnabled: false,
      tickIntervalMs: 1,
      initialDelayMs: 1,
      failedMaxRetries: 3,
      failedQuarantineHours: 24,
      abandonedRetentionDays: 7,
      dustCompositeThreshold: 25,
      dustRetentionDays: 30,
    });
    expect(setSpy).not.toHaveBeenCalled();
    handle.stop();
    setSpy.mockRestore();
  });

  it("returns a stop() handle that cancels the timer", () => {
    const handle = startReportsPruneScheduler({
      enabled: true,
      dustEnabled: false,
      tickIntervalMs: 60_000,
      initialDelayMs: 60_000,
      failedMaxRetries: 3,
      failedQuarantineHours: 24,
      abandonedRetentionDays: 7,
      dustCompositeThreshold: 25,
      dustRetentionDays: 30,
    });
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });
});
