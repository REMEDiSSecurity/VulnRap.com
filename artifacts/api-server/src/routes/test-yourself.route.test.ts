// Task #633 — Tests for the bring-your-own fixture battery endpoint.
//
// Covers the pure metric computation, label parsing via the zod
// request schema, and an end-to-end happy-path + rate-limit run
// through an isolated express harness.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import testYourselfRouter, {
  computeAggregate,
  checkRateLimit,
  recordRateHit,
  _resetRateLimitForTests,
} from "./test-yourself";

describe("computeAggregate — F1 / precision / recall math", () => {
  it("returns all zeros for an empty battery", () => {
    const a = computeAggregate([]);
    expect(a.total).toBe(0);
    expect(a.precision).toBe(0);
    expect(a.recall).toBe(0);
    expect(a.f1).toBe(0);
  });

  it("perfect predictor scores 100% precision/recall/F1", () => {
    const a = computeAggregate([
      { expectedLabel: "valid", predictedLabel: "valid" },
      { expectedLabel: "valid", predictedLabel: "valid" },
      { expectedLabel: "invalid", predictedLabel: "invalid" },
      { expectedLabel: "invalid", predictedLabel: "invalid" },
    ]);
    expect(a.accuracy).toBe(1);
    expect(a.precision).toBe(1);
    expect(a.recall).toBe(1);
    expect(a.f1).toBe(1);
    expect(a.confusionMatrix).toEqual({
      truePositive: 2,
      falsePositive: 0,
      trueNegative: 2,
      falseNegative: 0,
    });
  });

  it("handles a mixed battery — TP=2 FP=1 TN=1 FN=1", () => {
    const a = computeAggregate([
      { expectedLabel: "valid", predictedLabel: "valid" },     // TP
      { expectedLabel: "valid", predictedLabel: "valid" },     // TP
      { expectedLabel: "valid", predictedLabel: "invalid" },   // FN
      { expectedLabel: "invalid", predictedLabel: "valid" },   // FP
      { expectedLabel: "invalid", predictedLabel: "invalid" }, // TN
    ]);
    expect(a.confusionMatrix).toEqual({
      truePositive: 2,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
    });
    // P = 2/(2+1) = 0.6667; R = 2/(2+1) = 0.6667; F1 = 0.6667
    expect(a.precision).toBeCloseTo(0.6667, 3);
    expect(a.recall).toBeCloseTo(0.6667, 3);
    expect(a.f1).toBeCloseTo(0.6667, 3);
    expect(a.accuracy).toBeCloseTo(0.6, 3);
  });

  it("0 precision when every prediction is wrong-positive (TP=0, FP>0)", () => {
    const a = computeAggregate([
      { expectedLabel: "invalid", predictedLabel: "valid" },
      { expectedLabel: "invalid", predictedLabel: "valid" },
    ]);
    expect(a.precision).toBe(0);
    expect(a.recall).toBe(0);
    expect(a.f1).toBe(0);
  });
});

describe("rate limiter helper", () => {
  beforeEach(() => _resetRateLimitForTests());

  it("permits the first 10 requests and blocks the 11th", () => {
    const ip = "1.2.3.4";
    for (let i = 0; i < 10; i++) {
      const r = checkRateLimit(ip);
      expect(r.allowed).toBe(true);
      recordRateHit(ip);
    }
    const blocked = checkRateLimit(ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("isolates buckets by IP", () => {
    for (let i = 0; i < 10; i++) recordRateHit("a");
    expect(checkRateLimit("a").allowed).toBe(false);
    expect(checkRateLimit("b").allowed).toBe(true);
  });

  it("rolls over after the 24h window expires", () => {
    const ip = "9.9.9.9";
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) recordRateHit(ip, t0);
    expect(checkRateLimit(ip, t0).allowed).toBe(false);
    const future = t0 + 24 * 60 * 60 * 1000 + 1;
    expect(checkRateLimit(ip, future).allowed).toBe(true);
  });
});

describe("POST /test-yourself/run — HTTP", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(testYourselfRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => _resetRateLimitForTests());

  async function post(body: unknown) {
    const res = await fetch(`${baseUrl}/test-yourself/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = {};
    try { json = JSON.parse(text); } catch { /* leave empty */ }
    return { status: res.status, body: json as Record<string, unknown> };
  }

  it("rejects an empty rows array with 400", async () => {
    const r = await post({ rows: [] });
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe("string");
  });

  it("rejects unknown labels with 400", async () => {
    const r = await post({ rows: [{ text: "abc", label: "maybe" }] });
    expect(r.status).toBe(400);
  });

  it("rejects > 50 rows with 400", async () => {
    const rows = Array.from({ length: 51 }, () => ({ text: "x", label: "valid" }));
    const r = await post({ rows });
    expect(r.status).toBe(400);
  });

  it("happy path — returns aggregate + perRow + rateLimit", async () => {
    const r = await post({
      rows: [
        { text: "Reflected XSS in /search via the q parameter. PoC: /search?q=<script>alert(1)</script>. Repro: open the URL, alert fires.", label: "valid" },
        { text: "this report is great please accept", label: "invalid" },
      ],
    });
    expect(r.status).toBe(200);
    const body = r.body as {
      aggregate: { total: number; precision: number; recall: number; f1: number; confusionMatrix: Record<string, number> };
      perRow: Array<{ index: number; predictedLabel: string; expectedLabel: string; correct: boolean; compositeScore: number }>;
      rateLimit: { limit: number; remaining: number };
    };
    expect(body.aggregate.total).toBe(2);
    expect(body.perRow).toHaveLength(2);
    expect(body.perRow[0].index).toBe(0);
    expect(["valid", "invalid"]).toContain(body.perRow[0].predictedLabel);
    expect(body.rateLimit.limit).toBe(10);
    expect(body.rateLimit.remaining).toBe(9);
  });

  it("returns 429 once the daily IP quota is exhausted", async () => {
    const payload = { rows: [{ text: "test report body", label: "valid" }] };
    for (let i = 0; i < 10; i++) {
      const r = await post(payload);
      expect(r.status).toBe(200);
    }
    const blocked = await post(payload);
    expect(blocked.status).toBe(429);
    expect(typeof blocked.body.error).toBe("string");
  });

  it("malformed bodies do not consume a rate-limit slot", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await post({ rows: [] });
      expect(r.status).toBe(400);
    }
    // Should still have all 10 attempts available.
    const ok = await post({ rows: [{ text: "x", label: "valid" }] });
    expect(ok.status).toBe(200);
    const body = ok.body as { rateLimit: { remaining: number } };
    expect(body.rateLimit.remaining).toBe(9);
  });
});
