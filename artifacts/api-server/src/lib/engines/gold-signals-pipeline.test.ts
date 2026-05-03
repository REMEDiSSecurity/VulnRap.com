// Task #239 — end-to-end pipeline regression test for the strong-evidence
// GOLD_SIGNAL categories added in Task #174.
//
// `gold-signals.test.ts` already covers each detector in isolation (one
// payload per fixture, asserted via `runEngine2`). This file goes one
// level higher and exercises the full default Engine 2 pipeline
// (`extractSignals → runEngine2`) AND the composite pipeline
// (`analyzeWithEnginesTraced`, `forceAvri: false`) on a *single*
// representative report containing payloads from several of the new
// categories at once. It locks in two things a per-category unit test
// can't:
//
//   1. The new GOLD_SIGNAL strings actually surface on the engine
//      result that the diagnostics UI / API response read from
//      (`composite.engineResults["Technical Substance Analyzer"].triggeredIndicators`).
//   2. They demonstrably influence the visible signal list — the same
//      report with every payload replaced by a placeholder slot
//      produces a strictly smaller GOLD_SIGNAL set AND a materially
//      lower Engine 2 score (so a regression that silently drops the
//      detectors would be caught by both an indicator assertion and a
//      score assertion).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runEngine2,
  type EngineResult,
  type TriggeredIndicator,
} from "./engines";
import { extractSignals } from "./extractors";
import { analyzeWithEnginesTraced } from "./index";

const E2_NAME = "Technical Substance Analyzer";

function goldIds(indicators: TriggeredIndicator[]): string[] {
  return indicators
    .filter((i) => i.signal === "GOLD_SIGNAL")
    .map((i) => String(i.value));
}

function e2From(engineResults: EngineResult[]): EngineResult {
  const e2 = engineResults.find((e) => e.engine === E2_NAME);
  if (!e2) throw new Error(`expected ${E2_NAME} in engine results`);
  return e2;
}

// A representative report touching five of the Task #174 categories at
// once: auth_token, sql_injection_payload, xss_payload,
// ssrf_metadata_target, path_traversal_payload. Plus a real unified diff
// (code_diff) so the curated category emits alongside and we
// incidentally lock its coexistence in.
const REPRESENTATIVE_REPORT = `
# Multi-category vulnerability report (CWE-89, CWE-79, CWE-918, CWE-22)

## 1. Auth context (concrete bearer token)

\`\`\`http
GET /api/orders/4815 HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.M2y7fT_kQpL9Ztq8RxYbN3wVcGdHaJoP5sB1uEiKxzA
User-Agent: curl/8.4.0
\`\`\`

## 2. SQL injection on /search (q parameter)

The \`q\` parameter is concatenated unsanitized in src/handlers/search.py:42.

\`\`\`http
POST /search HTTP/1.1
Host: shop.example.com
Content-Type: application/x-www-form-urlencoded

q=' UNION SELECT username, password FROM users--
\`\`\`

## 3. Stored XSS in /comments

The comment field renders unescaped in src/render/comment.tsx:94. Posting:

\`\`\`html
<script>alert(document.cookie)</script>
\`\`\`

…executes the payload for every visitor of /post/123.

## 4. SSRF reaching AWS instance metadata

The /api/fetch?url= parameter blindly dereferences any URL (src/api/fetch.py:18):

\`\`\`http
GET /api/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/admin HTTP/1.1
Host: app.example.com
\`\`\`

## 5. Path traversal in /download?file=

\`\`\`http
GET /download?file=../../../../etc/passwd HTTP/1.1
Host: app.example.com
\`\`\`

## 6. Patch

\`\`\`diff
--- a/src/handlers/search.py
+++ b/src/handlers/search.py
@@ -40,7 +40,7 @@ def search(q: str):
-    return db.execute("SELECT * FROM items WHERE name LIKE '%" + q + "%'")
+    return db.execute("SELECT * FROM items WHERE name LIKE %s", (f"%{q}%",))
\`\`\`
`;

// Same shape and structure as REPRESENTATIVE_REPORT but every concrete
// payload is replaced with a placeholder slot. Used as the negative
// control: a regression that silently weakens the placeholder
// validators would let these slots earn gold signals.
const PLACEHOLDER_REPORT = `
# Multi-category vulnerability report (CWE-89, CWE-79, CWE-918, CWE-22)

## 1. Auth context

\`\`\`http
GET /api/orders/<id> HTTP/1.1
Host: <target>
Authorization: Bearer <jwt-token-here>
User-Agent: curl/8.4.0
\`\`\`

## 2. SQL injection on /search (q parameter)

\`\`\`http
POST /search HTTP/1.1
Host: <target>
Content-Type: application/x-www-form-urlencoded

q=<sql payload here>
\`\`\`

Payload: \`<inject>\` against the search endpoint.

## 3. Stored XSS in /comments

The vulnerable parameter accepts an XSS payload:

\`\`\`http
GET /search?q=<payload here> HTTP/1.1
Host: <target>
\`\`\`

Inject: \`<script>\` into the q parameter.

## 4. SSRF reaching cloud metadata

Use \`<metadata-url>\` as the URL parameter to retrieve credentials.

\`\`\`http
GET /api/fetch?url=<metadata-url> HTTP/1.1
Host: <target>
\`\`\`

## 5. Path traversal in /download?file=

\`\`\`http
GET /download?file=../../<sensitive-file> HTTP/1.1
Host: <target>
\`\`\`

Send: \`<traversal>\` to read system files.
`;

const REPORT_CWES = ["CWE-89", "CWE-79", "CWE-918", "CWE-22"];

// New strong-evidence categories the representative report should earn.
// Locked in here (rather than asserting "at least N gold signals") so a
// regression that silently drops a single category fails this test
// loudly with the dropped category named in the diff.
const EXPECTED_NEW_CATEGORIES = [
  "auth_token",
  "sql_injection_payload",
  "xss_payload",
  "ssrf_metadata_target",
  "path_traversal_payload",
];

describe("Task #239: strong-evidence GOLD_SIGNAL categories — full default pipeline", () => {
  let originalAvri: string | undefined;
  let originalSubstanceCap: string | undefined;
  beforeEach(() => {
    originalAvri = process.env.VULNRAP_USE_AVRI;
    originalSubstanceCap = process.env.VULNRAP_E3_SUBSTANCE_CAP;
    // The "default Engine 2 pipeline" the task refers to is the legacy
    // (non-AVRI) path. Force it off so we don't accidentally exercise
    // the AVRI-only detectors instead.
    process.env.VULNRAP_USE_AVRI = "false";
    process.env.VULNRAP_E3_SUBSTANCE_CAP = "true";
  });
  afterEach(() => {
    if (originalAvri === undefined) delete process.env.VULNRAP_USE_AVRI;
    else process.env.VULNRAP_USE_AVRI = originalAvri;
    if (originalSubstanceCap === undefined)
      delete process.env.VULNRAP_E3_SUBSTANCE_CAP;
    else process.env.VULNRAP_E3_SUBSTANCE_CAP = originalSubstanceCap;
  });

  it("runEngine2 emits every expected new GOLD_SIGNAL on a multi-category report", () => {
    const signals = extractSignals(REPRESENTATIVE_REPORT, REPORT_CWES);
    const e2 = runEngine2(signals, REPRESENTATIVE_REPORT);

    const golds = goldIds(e2.triggeredIndicators);
    for (const expected of EXPECTED_NEW_CATEGORIES) {
      expect(
        golds,
        `missing GOLD_SIGNAL=${expected}; got [${golds.join(", ")}]`,
      ).toContain(expected);
    }
    // Curated code_diff stays alongside the new categories.
    expect(golds).toContain("code_diff");

    // Each GOLD_SIGNAL value is unique — the dedupe in runEngine2 keeps
    // additional detectors from overwriting the curated three.
    expect(new Set(golds).size).toBe(golds.length);

    // Every GOLD_SIGNAL indicator carries a HIGH or MEDIUM strength and
    // a non-empty explanation, since downstream UI surfaces these
    // verbatim in the diagnostics panel.
    for (const ind of e2.triggeredIndicators.filter(
      (i) => i.signal === "GOLD_SIGNAL",
    )) {
      expect(["HIGH", "MEDIUM"]).toContain(ind.strength);
      expect(typeof ind.explanation).toBe("string");
      expect((ind.explanation ?? "").length).toBeGreaterThan(0);
    }
  });

  it("analyzeWithEnginesTraced surfaces the new GOLD_SIGNAL strings on the visible engine result", () => {
    const { composite } = analyzeWithEnginesTraced(REPRESENTATIVE_REPORT, {
      claimedCwes: REPORT_CWES,
      forceAvri: false,
    });

    const e2 = e2From(composite.engineResults);
    const golds = goldIds(e2.triggeredIndicators);
    for (const expected of EXPECTED_NEW_CATEGORIES) {
      expect(
        golds,
        `missing GOLD_SIGNAL=${expected} in composite output; got [${golds.join(", ")}]`,
      ).toContain(expected);
    }

    // Sanity: the composite uses the legacy (non-AVRI) engine list.
    expect(composite.engineResults.map((e) => e.engine)).toEqual([
      "AI Authorship Detector",
      "Technical Substance Analyzer",
      "CWE Coherence Checker",
    ]);
  });

  it("placeholder-only equivalent earns NONE of the new GOLD_SIGNAL categories", () => {
    const signals = extractSignals(PLACEHOLDER_REPORT, REPORT_CWES);
    const e2 = runEngine2(signals, PLACEHOLDER_REPORT);
    const golds = goldIds(e2.triggeredIndicators);
    for (const blocked of EXPECTED_NEW_CATEGORIES) {
      expect(
        golds,
        `placeholder-only report leaked GOLD_SIGNAL=${blocked}`,
      ).not.toContain(blocked);
    }
  });

  it("new GOLD_SIGNAL categories influence Engine 2's visible score (real > placeholder)", () => {
    // Locks the second part of the task brief: the new strong-evidence
    // categories must "influence the visible signal list", not just
    // appear inert. We exercise this by comparing the Engine 2 score
    // produced by the real report against the placeholder-only
    // equivalent. The strength-multiplier bonus in runEngine2 is the
    // mechanism — typed evidence signals (CRASH_OUTPUT / HTTP_REQUEST /
    // CODE_DIFF) plus the GOLD_SIGNAL emission together produce the
    // higher score. A regression that silently drops the detectors AND
    // their evidence-signal contributions would collapse the gap to ~0.
    const real = analyzeWithEnginesTraced(REPRESENTATIVE_REPORT, {
      claimedCwes: REPORT_CWES,
      forceAvri: false,
    });
    const placeholder = analyzeWithEnginesTraced(PLACEHOLDER_REPORT, {
      claimedCwes: REPORT_CWES,
      forceAvri: false,
    });

    const realE2 = e2From(real.composite.engineResults);
    const placeholderE2 = e2From(placeholder.composite.engineResults);

    const realGoldCount = goldIds(realE2.triggeredIndicators).length;
    const placeholderGoldCount = goldIds(
      placeholderE2.triggeredIndicators,
    ).length;
    expect(realGoldCount).toBeGreaterThan(placeholderGoldCount);
    // Real report should surface at least the five expected new
    // categories + code_diff = 6 gold signals minimum.
    expect(realGoldCount).toBeGreaterThanOrEqual(6);

    // Material score gap. We pick a conservative threshold (≥10 points)
    // so small re-tunings of the strength-multiplier formula don't make
    // this assertion flaky, while still catching a "detectors silently
    // disabled" regression (which would collapse the gap toward 0).
    expect(realE2.score - placeholderE2.score).toBeGreaterThanOrEqual(10);
  });
});
