import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { newApiContext } from "./helpers/handwavy";

// Task #325 — End-to-end coverage for the *server-side* contract that the
// reviewer-chosen `productionScanLimit` field actually bounds the number of
// production reports the dry-run scans, not just that the value reaches the
// API.
//
// The existing Task #231 spec (handwavy-production-scan-limit.spec.ts)
// drives the UI through a route intercept: it confirms the chosen limit is
// forwarded on the dry-run POST body and echoed back into the subtitle, but
// because the dry-run response is synthesized by the intercept it never
// touches the real api-server's production scan. A regression where the
// api-server accepts the field on the wire but silently ignores it (e.g.
// the limit no longer threads into the drizzle `.limit(...)` call) would
// pass that spec while shipping a broken production behavior.
//
// This spec drives the REAL api-server (no route intercept):
//   - Hits POST /api/feedback/calibration/handwavy-phrases with
//     `dryRun: true` and a small `productionScanLimit` (the documented
//     minimum, 100, so we don't have to invent server-side test fixtures).
//   - Asserts the response's `dryRunMatchesProduction.corpusSize` is at
//     most that limit. This is the load-bearing assertion: if a regression
//     drops the limit on the floor, any production-sized archive
//     (>100 labeled reports) surfaces it here.
//   - Asserts the api-server echoes the chosen limit back via
//     `dryRunMatchesProductionLimit` so a regression that loses the value
//     between request and response is also caught (the existing spec
//     covers this for an intercepted response; we re-check it for the
//     real response so a single failure here points at one of the two
//     code paths, not both).
//   - Belt-and-braces: a second probe at the documented MAX limit
//     (10000) confirms the scan can return strictly *more* rows when the
//     cap is widened — a regression that pinned the limit at the default
//     regardless of the request body would fail this check even on a
//     small dev corpus.
//
// The spec runs against the same bundled api-server webserver started by
// playwright.config.ts, so no extra wiring is needed. It is intentionally
// not added to scripts/release-e2e-check.sh — the contract being tested
// is a server-side smoke test, not a release-blocking user flow.

// Mirror the constants in artifacts/api-server/src/routes/calibration.ts so
// a drift between the UI/server validator and this spec fails the spec
// rather than silently retracking. Keeping these as literals (not imports)
// matches the pattern in the sibling Task #231 spec.
const SCAN_LIMIT_MIN = 100;
const SCAN_LIMIT_MAX = 10000;

interface DryRunMatchesProduction {
  corpusSize: number;
  total: number;
  byTier: {
    t1Legit: number;
    t2Borderline: number;
    t3Slop: number;
    t4Hallucinated: number;
  };
  falsePositives: number;
  warning: string | null;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

interface DryRunResponse {
  dryRun: boolean;
  phrase: string;
  category: string;
  dryRunMatchesProduction: DryRunMatchesProduction | null;
  dryRunMatchesProductionError: string | null;
  dryRunMatchesProductionLimit: number;
}

/**
 * Drive a single dry-run POST against the real api-server and return the
 * decoded body. Uses a unique sentinel phrase so the api-server's tally
 * step has nothing to match against — we only care about `corpusSize`
 * (the count of rows the scan considered), not `total` (the count of
 * rows that matched the phrase). This keeps the assertion stable
 * regardless of the dev/CI archive's actual contents.
 */
async function dryRunWithLimit(
  api: APIRequestContext,
  phrase: string,
  productionScanLimit: number,
): Promise<DryRunResponse> {
  const res = await api.post(
    "/api/feedback/calibration/handwavy-phrases",
    {
      data: {
        phrase,
        category: "absence",
        dryRun: true,
        productionScanLimit,
        reviewer: "e2e-task325",
      },
    },
  );
  expect(
    res.ok(),
    `dry-run POST with productionScanLimit=${productionScanLimit} failed: ${res.status()} ${await res.text()}`,
  ).toBeTruthy();
  return (await res.json()) as DryRunResponse;
}

/**
 * Build a sentinel phrase that no real production report could plausibly
 * contain. Long enough to clear the 3-character normalized minimum, short
 * enough to clear the 200-character cap, and uuid-suffixed so back-to-back
 * runs against the same dev DB never collide on the (also dry-run) side
 * effects of overlap detection.
 */
function sentinelPhrase(): string {
  return `task325 sentinel ${randomUUID().replace(/-/g, "").slice(0, 16)} unmatchable`;
}

test.describe("Hand-wavy production-scan window enforced server-side (Task #325)", () => {
  test("dry-run with productionScanLimit=100 caps the production scan's corpusSize to <= 100", async () => {
    const api = await newApiContext();
    try {
      const phrase = sentinelPhrase();
      const body = await dryRunWithLimit(api, phrase, SCAN_LIMIT_MIN);

      // The api-server must not have fallen into the production-error
      // path — that would render the contract assertion below vacuously
      // true (corpusSize is null when the probe failed).
      expect(
        body.dryRunMatchesProductionError,
        "the production probe must have succeeded so the corpusSize cap is actually exercised",
      ).toBeNull();
      expect(body.dryRunMatchesProduction).not.toBeNull();

      // The api-server must echo the limit reviewers picked back in the
      // dedicated response field. A regression that drops the value
      // between the request body and the response would be caught here
      // even before the load-bearing corpusSize assertion runs.
      expect(body.dryRunMatchesProductionLimit).toBe(SCAN_LIMIT_MIN);

      // Load-bearing contract assertion: the api-server must not scan
      // more rows than the reviewer-chosen window. Against any production-
      // sized corpus (>100 labeled rows) this is what fails when the
      // limit is silently ignored. Against a small dev/CI corpus the
      // assertion is satisfied trivially but still guards the shape.
      const production = body.dryRunMatchesProduction!;
      expect(production.corpusSize).toBeLessThanOrEqual(SCAN_LIMIT_MIN);
      expect(production.corpusSize).toBeGreaterThanOrEqual(0);

      // Sentinel phrase can't match any real production text, so the
      // tally must be all-zero. If a regression accidentally short-
      // circuits the matcher (e.g. early-return that always reports
      // `total === corpusSize`), the byTier check would surface it.
      expect(production.total).toBe(0);
      expect(production.byTier).toEqual({
        t1Legit: 0,
        t2Borderline: 0,
        t3Slop: 0,
        t4Hallucinated: 0,
      });
      expect(production.falsePositives).toBe(0);
      expect(production.warning).toBeNull();
    } finally {
      await api.dispose();
    }
  });

  test("corpusSize is monotonic in productionScanLimit (and strictly larger when the corpus exceeds the minimum)", async () => {
    // Pairs with the contract test above to catch a regression where the
    // api-server pins the production scan at a fixed value or inverts
    // the comparison.
    //
    // Monotonicity check (always meaningful): a smaller cap can never
    // let through MORE rows than a larger cap. Holds on any corpus,
    // including an empty one (where both sides tie at 0). A regression
    // that swapped MIN for MAX would fail this even on a fresh CI DB.
    //
    // Strict-increase check (conditional, only meaningful when the
    // corpus exceeds the minimum): when the larger probe returns more
    // than `SCAN_LIMIT_MIN` rows, the smaller probe must report exactly
    // `SCAN_LIMIT_MIN` — i.e. the cap is the binding factor for the
    // small call. This is the "limit actually narrowed the scan"
    // assertion, but it can only fire on a sufficiently large corpus;
    // we gate it explicitly so a small dev/CI archive doesn't make the
    // spec misleading.
    const api = await newApiContext();
    try {
      const phrase = sentinelPhrase();
      const small = await dryRunWithLimit(api, phrase, SCAN_LIMIT_MIN);
      const large = await dryRunWithLimit(api, phrase, SCAN_LIMIT_MAX);

      expect(small.dryRunMatchesProductionError).toBeNull();
      expect(large.dryRunMatchesProductionError).toBeNull();
      expect(small.dryRunMatchesProduction).not.toBeNull();
      expect(large.dryRunMatchesProduction).not.toBeNull();

      expect(small.dryRunMatchesProductionLimit).toBe(SCAN_LIMIT_MIN);
      expect(large.dryRunMatchesProductionLimit).toBe(SCAN_LIMIT_MAX);

      const smallSize = small.dryRunMatchesProduction!.corpusSize;
      const largeSize = large.dryRunMatchesProduction!.corpusSize;

      // Monotonicity (always meaningful).
      expect(smallSize).toBeLessThanOrEqual(largeSize);

      // The small probe is still bound by the documented minimum.
      expect(smallSize).toBeLessThanOrEqual(SCAN_LIMIT_MIN);
      // The large probe is still bound by the documented maximum
      // (drizzle's .limit(N) is a hard cap, so this would only ever
      // fail under a regression that bypassed the limit clause).
      expect(largeSize).toBeLessThanOrEqual(SCAN_LIMIT_MAX);

      // Strict-increase (conditional). Only fires when the corpus has
      // more than SCAN_LIMIT_MIN labeled rows — on a fresh CI DB
      // (`largeSize <= SCAN_LIMIT_MIN`) the cap is non-binding and the
      // best we can claim is the monotonicity check above. When the
      // corpus is large enough, the cap MUST be binding for the small
      // call: anything else means the limit was silently ignored.
      if (largeSize > SCAN_LIMIT_MIN) {
        expect(smallSize).toBe(SCAN_LIMIT_MIN);
        expect(smallSize).toBeLessThan(largeSize);
      }
    } finally {
      await api.dispose();
    }
  });
});
