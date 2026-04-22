// Sprint 12 — route-level contract test for GET /api/test/run.
// Mounts the router on an isolated express app and asserts the
// `archetypes` grouping exposes the emerging slop fixtures with the
// per-fixture AVRI on/off + distance-to-ceiling fields that calibration
// consumers depend on.
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import testFixturesRouter from "./test-fixtures";

interface ArchetypeFixture {
  id: string;
  tier: string;
  composite: number;
  avriOnScore: number;
  avriOffScore: number | null;
  distanceToCeiling: number;
  triage: string;
  passed: boolean;
}

interface ArchetypeGroup {
  archetype: string;
  count: number;
  avriOnMean: number;
  avriOnMax: number;
  minDistanceToCeiling: number;
  ceiling: number;
  fixtures: ArchetypeFixture[];
}

interface TestRunResponse {
  fixtureCount: number;
  results: Array<{ id: string; archetype: string | null }>;
  archetypes: ArchetypeGroup[];
}

let server: http.Server;
let baseUrl: string;
const previousNodeEnv = process.env.NODE_ENV;

beforeAll(async () => {
  delete process.env.NODE_ENV; // route 404s in production
  const app = express();
  app.use("/api", testFixturesRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function fetchTestRun(): Promise<TestRunResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}/api/test/run`, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

describe("GET /api/test/run — Sprint 12 emerging slop archetypes", () => {
  it("groups Sprint 12 fixtures by archetype with AVRI on/off + headroom fields", async () => {
    const body = await fetchTestRun();

    expect(Array.isArray(body.archetypes)).toBe(true);
    const expected = [
      "fabricated_diff",
      "narrated_curl",
      "paraphrased_cve",
      "prose_poc",
      "pseudo_asan",
    ];
    const labels = body.archetypes.map(a => a.archetype).sort();
    expect(labels).toEqual(expected);

    for (const group of body.archetypes) {
      expect(group.ceiling).toBe(35);
      expect(group.count).toBeGreaterThanOrEqual(1);
      expect(group.fixtures.length).toBe(group.count);
      for (const f of group.fixtures) {
        expect(typeof f.avriOnScore).toBe("number");
        expect(typeof f.distanceToCeiling).toBe("number");
        expect(f.distanceToCeiling).toBeCloseTo(35 - f.avriOnScore, 1);
        expect(f.tier).toBe("T3_SLOP");
      }
      const maxOn = Math.max(...group.fixtures.map(f => f.avriOnScore));
      expect(group.avriOnMax).toBeCloseTo(maxOn, 1);
      expect(group.minDistanceToCeiling).toBeCloseTo(35 - maxOn, 1);
    }

    const sprint12Ids = new Set(body.archetypes.flatMap(a => a.fixtures.map(f => f.id)));
    for (const id of [
      "T3-11-fabricated-diff-no-proof",
      "T3-12-paraphrased-cve-renamed-fn",
      "T3-13-narrated-curl-no-evidence",
      "T3-14-pseudo-asan-symbolless",
      "T3-15-prose-poc-no-payload",
      // Task #77 — cross-family fabricated_diff fixtures.
      "T3-16-fabricated-diff-injection",
      "T3-17-fabricated-diff-web-client",
      "T3-18-fabricated-diff-memory-corruption",
    ]) {
      expect(sprint12Ids.has(id), `archetype groups should include ${id}`).toBe(true);
    }

    const labeledTop = body.results.filter(r => r.archetype !== null).map(r => r.id).sort();
    expect(labeledTop).toEqual(
      [
        "T3-11-fabricated-diff-no-proof",
        "T3-12-paraphrased-cve-renamed-fn",
        "T3-13-narrated-curl-no-evidence",
        "T3-14-pseudo-asan-symbolless",
        "T3-15-prose-poc-no-payload",
        // Task #77 — cross-family fabricated_diff fixtures share the
        // existing "fabricated_diff" archetype label so calibration
        // groups them next to T3-11.
        "T3-16-fabricated-diff-injection",
        "T3-17-fabricated-diff-web-client",
        "T3-18-fabricated-diff-memory-corruption",
      ].sort(),
    );
  }, 60_000);
});
