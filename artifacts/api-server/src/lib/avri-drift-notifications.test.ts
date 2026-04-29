import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  dedupKeyForFlag,
  selectNewFlags,
  notifyDriftFlagsIfNew,
  __testing,
  type WebhookDispatcher,
  type WebhookPayload,
  type NotifiedFlagRecord,
} from "./avri-drift-notifications";
import type { AvriDriftReport, DriftFlag } from "./avri-drift";

function makeReport(overrides: Partial<AvriDriftReport> = {}): AvriDriftReport {
  return {
    generatedAt: "2026-04-29T00:00:00.000Z",
    weeksRequested: 8,
    totalReportsScanned: 100,
    cohort: "avri_on_only",
    bucketingNote: "test",
    thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
    weeks: [],
    flags: [],
    runbookPath: "docs/avri-drift-runbook.md",
    ...overrides,
  };
}

const GAP_FLAG: DriftFlag = {
  weekStart: "2026-04-20",
  kind: "GAP_BELOW_45",
  detail: "T1−T3 composite gap 40 < 45pt threshold (T1 n=5 mean=70, T3 n=5 mean=30).",
};

const FAM_FLAG_T1_INJ: DriftFlag = {
  weekStart: "2026-04-20",
  kind: "FAMILY_MEAN_SHIFT",
  detail: "T1 family INJECTION mean shifted by -7pt vs 2026-04-13 (was 80, now 73).",
};

const FAM_FLAG_T3_MEM: DriftFlag = {
  weekStart: "2026-04-20",
  kind: "FAMILY_MEAN_SHIFT",
  detail: "T3 family MEMORY_CORRUPTION mean shifted by +6pt vs 2026-04-13 (was 30, now 36).",
};

describe("dedupKeyForFlag", () => {
  it("scopes GAP_BELOW_45 by week + kind", () => {
    expect(dedupKeyForFlag(GAP_FLAG)).toBe("2026-04-20|GAP_BELOW_45");
  });

  it("scopes FAMILY_MEAN_SHIFT by week + bucket + family", () => {
    expect(dedupKeyForFlag(FAM_FLAG_T1_INJ)).toBe(
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    );
    expect(dedupKeyForFlag(FAM_FLAG_T3_MEM)).toBe(
      "2026-04-20|FAMILY_MEAN_SHIFT|T3|MEMORY_CORRUPTION",
    );
  });

  it("treats the same flag with different numeric values in detail as the same key", () => {
    const refreshed: DriftFlag = {
      ...FAM_FLAG_T1_INJ,
      detail: "T1 family INJECTION mean shifted by -9pt vs 2026-04-13 (was 80, now 71).",
    };
    expect(dedupKeyForFlag(refreshed)).toBe(dedupKeyForFlag(FAM_FLAG_T1_INJ));
  });

  it("falls back to week+kind when the FAMILY_MEAN_SHIFT detail format is unexpected", () => {
    const odd: DriftFlag = {
      weekStart: "2026-04-20",
      kind: "FAMILY_MEAN_SHIFT",
      detail: "totally different format",
    };
    expect(dedupKeyForFlag(odd)).toBe("2026-04-20|FAMILY_MEAN_SHIFT");
  });
});

describe("selectNewFlags", () => {
  const baseRecord = (key: string): NotifiedFlagRecord => ({
    key,
    weekStart: "2026-04-20",
    kind: "GAP_BELOW_45",
    notifiedAt: "2026-04-21T00:00:00.000Z",
    detail: "old",
  });

  it("partitions flags into new vs already-notified", () => {
    const out = selectNewFlags(
      [GAP_FLAG, FAM_FLAG_T1_INJ, FAM_FLAG_T3_MEM],
      [baseRecord("2026-04-20|GAP_BELOW_45")],
    );
    expect(out.newFlags.map((f) => f.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
      "2026-04-20|FAMILY_MEAN_SHIFT|T3|MEMORY_CORRUPTION",
    ]);
    expect(out.alreadyNotified.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
    ]);
  });

  it("collapses duplicates within a single report", () => {
    const out = selectNewFlags([GAP_FLAG, GAP_FLAG], []);
    expect(out.newFlags).toHaveLength(1);
    expect(out.alreadyNotified).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// notifyDriftFlagsIfNew — uses a tmp state file so we don't touch the shipped
// data/avri-drift-notifications.json. Each test gets its own fresh file.
// ---------------------------------------------------------------------------

describe("notifyDriftFlagsIfNew", () => {
  let tmpDir: string;
  let statePath: string;
  let originalEnv: {
    url?: string;
    statePath?: string;
    publicUrl?: string;
    runbookUrl?: string;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "avri-drift-notify-"));
    statePath = path.join(tmpDir, "notifications.json");
    originalEnv = {
      url: process.env.AVRI_DRIFT_WEBHOOK_URL,
      statePath: process.env.AVRI_DRIFT_NOTIFICATIONS_PATH,
      publicUrl: process.env.PUBLIC_URL,
      runbookUrl: process.env.AVRI_DRIFT_RUNBOOK_URL,
    };
    process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = statePath;
    delete process.env.AVRI_DRIFT_WEBHOOK_URL;
    delete process.env.PUBLIC_URL;
    delete process.env.AVRI_DRIFT_RUNBOOK_URL;
    __testing.resetResolvedPath();
  });

  afterEach(() => {
    if (originalEnv.url === undefined) delete process.env.AVRI_DRIFT_WEBHOOK_URL;
    else process.env.AVRI_DRIFT_WEBHOOK_URL = originalEnv.url;
    if (originalEnv.statePath === undefined)
      delete process.env.AVRI_DRIFT_NOTIFICATIONS_PATH;
    else process.env.AVRI_DRIFT_NOTIFICATIONS_PATH = originalEnv.statePath;
    if (originalEnv.publicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalEnv.publicUrl;
    if (originalEnv.runbookUrl === undefined)
      delete process.env.AVRI_DRIFT_RUNBOOK_URL;
    else process.env.AVRI_DRIFT_RUNBOOK_URL = originalEnv.runbookUrl;
    __testing.resetResolvedPath();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function recordingDispatcher(): {
    dispatch: WebhookDispatcher;
    calls: Array<{ url: string; payload: WebhookPayload }>;
    response: { ok: boolean; status?: number; error?: string };
  } {
    const calls: Array<{ url: string; payload: WebhookPayload }> = [];
    const handle = {
      dispatch: (async (url: string, payload: WebhookPayload) => {
        calls.push({ url, payload });
        return handle.response;
      }) as WebhookDispatcher,
      calls,
      response: { ok: true, status: 200 } as { ok: boolean; status?: number; error?: string },
    };
    return handle;
  }

  it("dispatches the webhook with all new flags and persists dedup state", async () => {
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG, FAM_FLAG_T1_INJ] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      publicUrl: "https://vulnrap.example.com",
      dispatch: rec.dispatch,
    });

    expect(outcome.dispatched).toBe(true);
    expect(outcome.webhookSkipped).toBe(false);
    expect(outcome.notified).toHaveLength(2);
    expect(outcome.alreadyNotified).toHaveLength(0);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe("https://example.com/hook");
    expect(rec.calls[0]!.payload.event).toBe("avri_drift_flags");
    expect(rec.calls[0]!.payload.calibrationUrl).toBe(
      "https://vulnrap.example.com/feedback-analytics",
    );
    expect(rec.calls[0]!.payload.runbookUrl).toBe(
      "https://vulnrap.example.com/docs/avri-drift-runbook.md",
    );
    expect(rec.calls[0]!.payload.flags.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);

    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      notified: NotifiedFlagRecord[];
    };
    expect(persisted.notified.map((n) => n.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);
  });

  it("does not re-dispatch flags that are already in the dedup state", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        notified: [
          {
            key: "2026-04-20|GAP_BELOW_45",
            weekStart: "2026-04-20",
            kind: "GAP_BELOW_45",
            notifiedAt: "2026-04-21T00:00:00.000Z",
            detail: "old",
          },
        ],
      }),
    );
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.notified).toHaveLength(0);
    expect(outcome.alreadyNotified).toHaveLength(1);
    expect(outcome.dispatched).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });

  it("dispatches new flags even when older flags from the same week are already notified", async () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        notified: [
          {
            key: "2026-04-20|GAP_BELOW_45",
            weekStart: "2026-04-20",
            kind: "GAP_BELOW_45",
            notifiedAt: "2026-04-21T00:00:00.000Z",
            detail: "old",
          },
        ],
      }),
    );
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG, FAM_FLAG_T1_INJ] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.notified.map((f) => f.key)).toEqual([
      "2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    ]);
    expect(outcome.alreadyNotified.map((f) => f.key)).toEqual([
      "2026-04-20|GAP_BELOW_45",
    ]);
    expect(rec.calls[0]!.payload.flags).toHaveLength(1);
  });

  it("does NOT mark flags as notified when the webhook fails", async () => {
    const rec = recordingDispatcher();
    rec.response = { ok: false, status: 503, error: "HTTP 503" };
    const report = makeReport({ flags: [GAP_FLAG] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.dispatched).toBe(false);
    expect(outcome.dispatchResult).toEqual({ ok: false, status: 503, error: "HTTP 503" });
    expect(outcome.notified).toHaveLength(0);
    // State file must not have been written / must remain empty so the next
    // dispatch will retry the same flag.
    if (existsSync(statePath)) {
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
        notified: NotifiedFlagRecord[];
      };
      expect(persisted.notified).toEqual([]);
    }
  });

  it("returns webhookSkipped + records flags when AVRI_DRIFT_WEBHOOK_URL is not set", async () => {
    const rec = recordingDispatcher();
    const report = makeReport({ flags: [GAP_FLAG] });
    const outcome = await notifyDriftFlagsIfNew(report, {
      // No webhookUrl override and AVRI_DRIFT_WEBHOOK_URL is unset by beforeEach.
      dispatch: rec.dispatch,
    });
    expect(rec.calls).toHaveLength(0);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.webhookSkipped).toBe(true);
    // Critical: we DID record the flag so a future webhook hookup doesn't
    // retroactively spam reviewers with a backlog.
    expect(outcome.notified.map((f) => f.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      notified: NotifiedFlagRecord[];
    };
    expect(persisted.notified.map((n) => n.key)).toEqual(["2026-04-20|GAP_BELOW_45"]);
  });

  it("returns a no-op outcome when the report has no flags", async () => {
    const rec = recordingDispatcher();
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [] }), {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.notified).toHaveLength(0);
    expect(outcome.alreadyNotified).toHaveLength(0);
    expect(outcome.dispatched).toBe(false);
    expect(rec.calls).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("falls back to PUBLIC_URL or vulnrap.com when no link override is provided", async () => {
    const rec = recordingDispatcher();
    process.env.PUBLIC_URL = "https://prod.example.com/";
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    // Trailing slash in PUBLIC_URL must be stripped.
    expect(outcome.calibrationUrl).toBe("https://prod.example.com/feedback-analytics");
    expect(outcome.runbookUrl).toBe(
      "https://prod.example.com/docs/avri-drift-runbook.md",
    );
  });

  it("uses AVRI_DRIFT_RUNBOOK_URL when provided so reviewers get a working link", async () => {
    const rec = recordingDispatcher();
    process.env.PUBLIC_URL = "https://prod.example.com";
    process.env.AVRI_DRIFT_RUNBOOK_URL =
      "https://github.com/example/vulnrap/blob/main/docs/avri-drift-runbook.md";
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      dispatch: rec.dispatch,
    });
    expect(outcome.calibrationUrl).toBe("https://prod.example.com/feedback-analytics");
    expect(outcome.runbookUrl).toBe(
      "https://github.com/example/vulnrap/blob/main/docs/avri-drift-runbook.md",
    );
    // The dispatched payload must carry the override too.
    expect(rec.calls[0]!.payload.runbookUrl).toBe(
      "https://github.com/example/vulnrap/blob/main/docs/avri-drift-runbook.md",
    );
  });

  it("prefers an explicit runbookUrl option over the env override", async () => {
    const rec = recordingDispatcher();
    process.env.AVRI_DRIFT_RUNBOOK_URL = "https://env.example.com/runbook";
    const outcome = await notifyDriftFlagsIfNew(makeReport({ flags: [GAP_FLAG] }), {
      webhookUrl: "https://example.com/hook",
      runbookUrl: "https://opt.example.com/runbook",
      dispatch: rec.dispatch,
    });
    expect(outcome.runbookUrl).toBe("https://opt.example.com/runbook");
  });
});
