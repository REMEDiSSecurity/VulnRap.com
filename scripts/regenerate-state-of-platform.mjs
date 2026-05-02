#!/usr/bin/env node
//
// regenerate-state-of-platform.mjs
//
// Single-source-of-truth generator for
// artifacts/api-server/docs/2026-05-02-state-of-platform.md.
//
// The doc is the user-facing "where is the platform today?" reference. It
// is partly introspected (endpoints, AVRI families, fixture counts, engine
// list, scoring-config version) and partly hand-written narrative kept
// inline below so a single re-run keeps both halves in sync.
//
// Usage:
//   node scripts/regenerate-state-of-platform.mjs            # write doc
//   node scripts/regenerate-state-of-platform.mjs --check    # error if doc would change
//
// The script has no external dependencies beyond the Node standard library
// and reads source files directly. It does not import any application
// code, so it is safe to run in CI or from a fresh clone before install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "artifacts/api-server/docs/2026-05-02-state-of-platform.md");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function extractEndpoints() {
  const yaml = read("lib/api-spec/openapi.yaml");
  const lines = yaml.split("\n");
  const endpoints = [];
  let currentPath = null;
  let cur = null;
  for (const line of lines) {
    const pathMatch = line.match(/^  (\/[^\s:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      cur = null;
      continue;
    }
    const methodMatch = line.match(/^    (get|post|put|delete|patch):\s*$/);
    if (methodMatch && currentPath) {
      cur = {
        path: currentPath,
        method: methodMatch[1].toUpperCase(),
        opId: null,
        summary: null,
        tag: null,
      };
      endpoints.push(cur);
      continue;
    }
    if (cur) {
      const opMatch = line.match(/^      operationId:\s*(\S+)/);
      if (opMatch) cur.opId = opMatch[1];
      const sumMatch = line.match(/^      summary:\s*(.+)$/);
      if (sumMatch) cur.summary = sumMatch[1].trim();
      const tagInline = line.match(/^      tags:\s*\[([^\]]+)\]/);
      if (tagInline) cur.tag = tagInline[1].trim();
    }
  }
  return endpoints;
}

function extractFamilies() {
  const src = read("artifacts/api-server/src/lib/engines/avri/families.ts");
  const blocks = src.split(/^const\s+/m).slice(1);
  const families = [];
  for (const b of blocks) {
    const idMatch = b.match(/id:\s*"(\w+)"/);
    if (!idMatch) continue;
    const dn = b.match(/displayName:\s*"([^"]+)"/);
    const vm = b.match(/verificationMode:\s*"(\w+)"/);
    const re = b.match(/reproductionExpectation:\s*"([^"]+)"/);
    const goldBlock = b.match(/goldSignals:\s*\[([\s\S]*?)\n\s*\],/);
    const goldCount = goldBlock
      ? (goldBlock[1].match(/\{\s*id:/g) || []).length
      : 0;
    const absBlock = b.match(/absencePenalties:\s*\[([\s\S]*?)\n\s*\],/);
    const absCount = absBlock
      ? (absBlock[1].match(/\{\s*id:/g) || []).length
      : 0;
    if (!dn) continue;
    families.push({
      id: idMatch[1],
      displayName: dn[1],
      verificationMode: vm ? vm[1] : "(unknown)",
      reproductionExpectation: re ? re[1] : null,
      goldSignalCount: goldCount,
      absencePenaltyCount: absCount,
    });
  }
  return families;
}

function extractFixtureCounts() {
  const src = read("artifacts/api-server/src/routes/test-fixtures.ts");
  const tiers = ["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP", "T4_HALLUCINATED"];
  const counts = {};
  for (const t of tiers) {
    const re = new RegExp(`tier:\\s*"${t}"`, "g");
    counts[t] = (src.match(re) || []).length;
  }
  counts.total = (src.match(/^\s*id:\s*"/gm) || []).length;
  return counts;
}

function extractScoringConfigVersion() {
  const src = read("artifacts/api-server/src/lib/scoring-config.ts");
  const versions = [...src.matchAll(/version:\s*"([^"]+)"/g)].map((m) => m[1]);
  return versions[versions.length - 1] || "(unknown)";
}

function extractAvriSlopSignalCount() {
  const src = read("artifacts/api-server/src/lib/engines/avri/slop-signals.ts");
  return (src.match(/^export function /gm) || []).length;
}

function extractEngineExports() {
  const src = read("artifacts/api-server/src/lib/engines/engines.ts");
  return [...src.matchAll(/^export function (run\w+|computeComposite)/gm)].map(
    (m) => m[1],
  );
}

function extractLibModuleCount() {
  const root = path.join(ROOT, "artifacts/api-server/src/lib");
  let count = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__snapshots__") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.includes(".test.")
      ) {
        count += 1;
      }
    }
  }
  walk(root);
  return count;
}

function extractAppVersionAndDate() {
  const src = read("artifacts/vulnrap/src/pages/changelog.tsx");
  const v = src.match(/CURRENT_VERSION\s*=\s*"([^"]+)"/);
  const d = src.match(/RELEASE_DATE\s*=\s*"([^"]+)"/);
  return {
    version: v ? v[1] : "(unknown)",
    date: d ? d[1] : "(unknown)",
  };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderEndpointsTable(endpoints) {
  const byTag = new Map();
  for (const e of endpoints) {
    const tag = e.tag || "(untagged)";
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(e);
  }
  const tagOrder = ["health", "reports", "feedback", "stats"];
  const knownTags = tagOrder.filter((t) => byTag.has(t));
  const otherTags = [...byTag.keys()]
    .filter((t) => !tagOrder.includes(t))
    .sort();
  const orderedTags = [...knownTags, ...otherTags];

  const out = [];
  for (const tag of orderedTags) {
    const rows = byTag.get(tag);
    out.push(`\n#### Tag: \`${tag}\` (${rows.length} operation${rows.length === 1 ? "" : "s"})\n`);
    out.push("| Method | Path | operationId | Summary |");
    out.push("| ------ | ---- | ----------- | ------- |");
    for (const e of rows) {
      const summary = (e.summary || "").replace(/\|/g, "\\|");
      out.push(
        `| \`${e.method}\` | \`${e.path}\` | \`${e.opId || "(none)"}\` | ${summary} |`,
      );
    }
  }
  return out.join("\n");
}

function renderFamiliesTable(families) {
  const out = [];
  out.push("| Family id | Display name | Verification mode | Gold signals | Absence penalties |");
  out.push("| --------- | ------------ | ----------------- | -----------: | ----------------: |");
  for (const f of families) {
    out.push(
      `| \`${f.id}\` | ${f.displayName.replace(/\|/g, "\\|")} | \`${f.verificationMode}\` | ${f.goldSignalCount} | ${f.absencePenaltyCount} |`,
    );
  }
  return out.join("\n");
}

function renderFamiliesReproductionList(families) {
  const out = [];
  for (const f of families) {
    if (!f.reproductionExpectation) continue;
    out.push(`- **\`${f.id}\` — ${f.displayName}**: ${f.reproductionExpectation}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Document body
// ---------------------------------------------------------------------------

function buildDocument() {
  const endpoints = extractEndpoints();
  const families = extractFamilies();
  const fixtureCounts = extractFixtureCounts();
  const scoringConfigVersion = extractScoringConfigVersion();
  const slopSignalCount = extractAvriSlopSignalCount();
  const engineFns = extractEngineExports();
  const libModules = extractLibModuleCount();
  const app = extractAppVersionAndDate();
  const generatedAt = new Date().toISOString().slice(0, 10);

  return `# State of the Platform — VulnRap

**Generated:** ${generatedAt} (regenerate with \`node scripts/regenerate-state-of-platform.mjs\`)
**App version at generation:** ${app.version} (released ${app.date})
**Scoring-config version at generation:** ${scoringConfigVersion}
**Endpoints introspected from:** \`lib/api-spec/openapi.yaml\` — ${endpoints.length} operations
**AVRI families introspected from:** \`artifacts/api-server/src/lib/engines/avri/families.ts\` — ${families.length} families
**Fixture battery introspected from:** \`artifacts/api-server/src/routes/test-fixtures.ts\` — ${fixtureCounts.total} fixtures
**Backend lib modules:** ${libModules} non-test \`.ts\` files in \`artifacts/api-server/src/lib/\`

This document is a single living reference for the current platform
state. It is partly auto-introspected from the codebase and partly
hand-written narrative kept inline in the regeneration script. Treat the
generated date above as the cut-off — this is not versioned per release.

---

## 1. Platform overview

VulnRap is a vulnerability-report validation platform. A submitter (a
researcher, a triage automation, an AI agent, a PSIRT inbox) hands us a
report; we hand back a validity verdict and the evidence behind it. The
platform is intentionally free, anonymous, and indexable by search and
AI crawlers — the only way the underlying detectors stay honest is if
the corpus they calibrate against is broad and public.

The product surface is a single React/Vite frontend
(\`artifacts/vulnrap/\`) talking to a single Express + PostgreSQL +
Drizzle backend (\`artifacts/api-server/\`) over an OpenAPI-described
API. The same API is the integration surface — there is no private
admin API the public one wraps; the calibration endpoints reuse the
same router, just behind reviewer auth.

The verdict the platform returns is built from three engines that vote
on a composite score, with active verification and section-fingerprint
duplicate detection layered on top. Each engine looks at a different
slice of evidence:

- **Engine 1 — Linguistic / structural cues.** The "this reads like
  generated text" signal. Cheap to run, deliberately weighted lightly
  (target ~5% of the composite) because pure style is the noisiest
  family of cues we have.
- **Engine 2 — AVRI / substance-of-PoC.** The largest weight on the
  composite (~60%). Family-aware: a memory-corruption report is graded
  against a different rubric than a web-XSS report. AVRI rubrics
  define gold signals (sanitizer traces, real CVE IDs, real commit
  SHAs) that pull substance up and absence penalties (no PoC
  payload, no version pin, no observable output) that pull it down.
- **Engine 3 — CWE coherence and family contradiction.** Asks
  "does the title agree with the evidence?" An XSS-titled report whose
  PoC is a SQL-injection payload trips a contradiction here regardless
  of how clean the prose is.

Around the engines:

- **Active verification** runs every CVE through NVD, every commit SHA
  through GitHub, every package through its registry. Tagged
  *referenced* (the report itself pointed at the source) or *fallback*
  (we had to find the source ourselves).
- **Similarity engine** — MinHash + LSH and Simhash for near-duplicate
  detection, SHA-256 for exact-match dedup, plus per-section
  fingerprints so reports that share paragraphs with prior submissions
  are caught even when the wrapper differs.
- **Auto-redaction** — deterministic regex strip of PII, secrets,
  credentials, and company names before storage or comparison. Runs on
  every submission unless the submitter explicitly opts out.

The platform's stance is that detection should rest on substance
(verifiable artifacts, family-appropriate evidence, internal
consistency) and not on prose-level cues. That is why Engine 2 carries
the dominant weight, why active verification is treated as
disambiguating ground truth rather than as a "tiebreaker," and why the
linguistic engine is constrained from outvoting the other two on its
own.

---

## 2. Scoring pipeline

The pipeline runs synchronously per submission in the request handler
behind \`POST /reports\` and \`POST /reports/check\`. There is no async
worker; submissions block on the analysis. The order below is the
order of execution in
\`artifacts/api-server/src/lib/engines/index.ts\` and
\`artifacts/api-server/src/routes/reports.ts\`:

1. **Auto-redaction** (\`src/lib/redactor.ts\`) — strip PII, secrets,
   company names. Result: redacted text + redaction summary.
2. **Section parser** (\`src/lib/section-parser.ts\`) — split into
   canonical report sections (Title, Summary, Affected, Steps,
   Observed, Expected, Mitigation) for fingerprinting.
3. **Signal extraction** (\`src/lib/engines/extractors.ts\`) — emits
   the unified \`ExtractedSignals\` record consumed by all three
   engines (CVE refs, code blocks, file paths, sanitizer traces, raw
   HTTP, claimed CWEs, claim density, paragraph hashes, ...).
4. **AVRI family classification**
   (\`src/lib/engines/avri/classify.ts\`) — pick the rubric this
   report should be graded against, falling back to \`FLAT\` when no
   family fingerprint dominates.
5. **Engine 1 — Linguistic** (\`engines.ts:runEngine1\`) — perplexity,
   handwavy phrase density, AI-self-disclosure, template-fingerprint
   match, fabricated-patch penalty, claim specificity.
6. **Engine 2 — AVRI substance** (\`engines.ts:runEngine2\` +
   \`engines/avri/engine2-avri.ts\`) — family-aware gold-signal points
   and absence penalties, fabricated-evidence flags
   (\`fabricated-evidence-flags.ts\`), substance gate, raw-HTTP sanity
   checks (\`engines/avri/raw-http.ts\`), crash-trace integrity
   (\`engines/avri/crash-trace.ts\`), template-campaign detector,
   velocity / replica-id signals, and the family-agnostic slop
   penalties in \`engines/avri/slop-signals.ts\` (currently
   ${slopSignalCount} exported penalty function${slopSignalCount === 1 ? "" : "s"}).
7. **Engine 3 — CWE coherence** (\`engines.ts:runEngine3\` +
   \`engines/cwe-fingerprints.ts\` + \`engines/avri/coherence.ts\`) —
   compare claimed CWE against the evidence shape, fire
   \`AVRI_FAMILY_CONTRADICTION\` and \`AVRI_NO_GOLD_SIGNALS\` where
   applicable.
8. **LLM gate** (\`src/lib/llm-slop.ts\`) — deterministic predicate
   that decides whether the LLM call is *worth* its cost given the
   composite signal so far. The LLM is *not* an engine; it is a refiner
   on the substance score, and the gate prevents spending tokens on
   rows that already have a clear answer.
9. **Active verification** (\`src/lib/active-verification.ts\` +
   \`factual-verification.ts\`) — live NVD / GitHub / registry checks.
   Backed by the PostgreSQL cache in \`cache-service.ts\`.
10. **Similarity** (\`src/lib/similarity.ts\`) — MinHash + LSH,
    Simhash, exact SHA-256, section fingerprints.
11. **Score fusion** (\`src/lib/score-fusion.ts\`) — combine engine
    votes into the composite, apply the fabrication boost, clamp to
    \`[floor, ceiling]\` from the active scoring config (current
    version: ${scoringConfigVersion}).
12. **Triage recommendation** (\`src/lib/triage-recommendation.ts\`) —
    map composite tier × verification outcome × similarity outcome to
    one of: \`AUTO_CLOSE\`, \`MANUAL_REVIEW\`, \`CHALLENGE_REPORTER\`,
    \`PRIORITIZE\`, \`STANDARD_TRIAGE\`.
13. **Persistence** — only on \`POST /reports\` (the \`/reports/check\`
    path is non-storing). Stores redacted text *iff* the submitter
    chose \`contentMode=full\`; otherwise only fingerprints and the
    composite trace are persisted.

The exported engine functions in \`engines.ts\` are:
${engineFns.map((f) => `\`${f}\``).join(", ")}.

---

## 3. Signal catalog

The two large signal vocabularies are the **AVRI family rubrics**
(per-family gold signals + absence penalties) and the **family-agnostic
slop signals** that fire across all rubrics. Both are introspected
below from source.

### AVRI families (Engine 2 substrate)

${renderFamiliesTable(families)}

The per-family reproduction expectation that AVRI grades against:

${renderFamiliesReproductionList(families)}

The total substrate is **${families.reduce((a, f) => a + f.goldSignalCount, 0)} gold-signal patterns** and
**${families.reduce((a, f) => a + f.absencePenaltyCount, 0)} absence-penalty patterns** across
${families.length} families. The \`FLAT\` family is the catch-all for reports
whose CWE classification is unknown or contested; it is deliberately
shallow so that "we don't know what this is" doesn't get scored as
"this passes."

### Family-agnostic slop signals

The penalties in \`src/lib/engines/avri/slop-signals.ts\` (currently
${slopSignalCount} function${slopSignalCount === 1 ? "" : "s"}) catch shapes that cut across families
— e.g. "claims to be a patch but contains no diff hunk or code block"
— and apply *after* family scoring so a report cannot escape a
cross-family slop pattern by being classified into a family whose
rubric happens not to require that evidence.

### Other indicator codes worth knowing

These are produced by various engine paths and surfaced in the trace:

- \`HALLUCINATION_FABRICATED_EVIDENCE\` — Engine 2 / hallucination
  detector (\`src/lib/hallucination-detector.ts\`). Round addresses,
  magic PIDs, repeated stack frames, impossible HTTP shapes.
- \`AVRI_FAMILY_CONTRADICTION\` — Engine 3. The classified family
  contradicts a phrase in the report (e.g. \`<script>\` inside a
  \`MEMORY_CORRUPTION\` classification).
- \`AVRI_NO_GOLD_SIGNALS\` — Engine 2. The chosen family's rubric
  produced zero gold-signal hits.
- \`AVRI_FABRICATED_PATCH\` — Slop-signals. Patch claim with no real
  diff or code block.
- \`AVRI_TEMPLATE_CAMPAIGN\` / \`AVRI_REPLICA_ID\` / \`AVRI_VELOCITY\`
  — Engine 2 cross-report signals (template fingerprint, replica id,
  submission velocity).
- \`SUBSTANCE_GATE\` — Score-fusion. The Engine 2 result is the
  substance gate; if substance is below the gate threshold, the
  composite is held at the lower tier even if Engine 1 wants to lift
  it.
- \`CRASH_TRACE_*\` / \`RAW_HTTP_*\` — Engine 2 sub-detectors with
  per-family gating (only fire when the family expects that evidence
  shape).

Every indicator code that can fire is asserted by at least one test in
\`artifacts/api-server/src/\`; \`hallucination-detector-cohort.test.ts\`
in particular pins which engine condemns each \`T4\` fixture so a
fixture that silently stops being condemned by its expected engine
fails the suite loudly.

---

## 4. Calibration and drift monitoring

VulnRap calibrates against three things: the synthetic fixture battery
in \`test-fixtures.ts\` (every commit), feedback collected on real
submissions (continuous), and rolling production AVRI traces
(weekly review).

The synthetic battery is the fast feedback loop. It runs in CI and
every fixture asserts an expected composite range, an expected Engine 2
range, and an expected triage action set. A regression in any one of
the three dimensions fails the suite. The doc
\`artifacts/api-server/docs/calibration/2026-04-30-avri-blend-calibration.md\`
captures the most recent ratio decision (the \`avriWeight = 0.5\`
substance/legacy blend held at Sprint 12 pending production trace
accumulation; re-evaluation scheduled 2026-05-13).

Feedback-driven calibration is in \`src/lib/calibration.ts\` plus the
calibration routes under \`/api/feedback/calibration/*\`. A reviewer
solves the proof-of-work challenge (\`src/lib/challenge.ts\`),
authenticates with the calibration token, and walks through suggested
weight changes generated by analyzing the feedback corpus against the
scoring outputs. Volume gating ensures suggestions are only made when
enough feedback exists to be meaningful.

The AVRI drift system (\`src/lib/avri-drift.ts\` and
\`src/lib/avri-drift-notifications.ts\`) provides the rolling
production view. It buckets each week's reports by triage outcome (T1
vs T3 equivalents), computes per-family means of the AVRI composite,
and fires drift flags when the rubric collapses or a family's weight
diverges from its calibrated baseline. The
\`/feedback/calibration/avri-drift\` endpoint surfaces the same view
publicly (read-only). A separate notifications webhook
(\`/feedback/calibration/avri-drift/notifications\`) lets the team get
alerted when a new drift flag arms; rearm history is kept so a noisy
flag doesn't keep paging.

The handwavy-phrase calibration
(\`/feedback/calibration/handwavy-phrases\`) is the workflow for
adding/removing the LLM-detection phrases that feed into Engine 1's
template-fingerprint signal. It supports batched removals, per-edit
revert, and a dry-run preview so reviewers can see the corpus impact
before applying a change.

The scoring-config version (current: ${scoringConfigVersion}) is the
header that pins every analysis output to the configuration that
produced it — so an older trace can be re-scored under a newer config
without losing the original verdict, and the drift flags can be
attributed to a specific config window.

---

## 5. Public API surface

Introspected from \`lib/api-spec/openapi.yaml\` — total
${endpoints.length} operations across the public surface. The base path
is \`/api\`. All endpoints are public except calibration write paths,
which require the reviewer token described in
\`docs/calibration-reviewer-token.md\`.
${renderEndpointsTable(endpoints)}

Beyond the table, the noteworthy shape facts:

- **\`POST /reports\`** is the storing path; **\`POST /reports/check\`**
  is the non-storing dry-run that returns the analysis fields
  (\`slopScore\`, \`slopTier\`, \`qualityScore\`, \`breakdown\`,
  \`evidence\`, \`similarityMatches\`) but no persistence handles —
  no report \`id\`, no delete token, no triage-report URL — so triage
  pipelines can sample a report against the corpus before deciding to
  submit.
- **\`GET /reports/lookup/{hash}\`** lets an integrator check whether a
  given SHA-256 of report content has been seen before without
  uploading the content itself.
- **\`GET /reports/{id}/triage-report\`** returns Markdown ready to
  paste into Jira / ServiceNow / GitHub issue trackers.
- **\`GET /reports/{id}/verify\`** is the lightweight verification badge
  endpoint — small JSON payload designed to be embedded in bug-bounty
  platform comment threads.
- **\`POST /feedback\`** requires a solved proof-of-work challenge from
  \`GET /feedback/challenge\` — this is the spam control on the
  public, no-account feedback path.

---

## 6. Reviewer surface

Beyond the public API, calibration reviewers have a separate UI
mounted in the same \`artifacts/vulnrap\` SPA, behind the calibration
token gate. The pages live under \`/calibration/*\` in the frontend and
are served by the same Express app via the
\`/feedback/calibration/*\` routes.

What reviewers can do:

- **Inspect feedback analytics** — rating distribution, daily trends,
  score-vs-feedback correlation, outlier reports, recent feedback
  entries (\`GET /feedback/analytics\`).
- **Run the calibration report** — see weight and threshold change
  suggestions with their evidence (\`GET /feedback/calibration\`),
  apply via \`POST /feedback/calibration/apply\` (audited).
- **Manage handwavy phrases** — add/remove the LLM-style phrases,
  preview corpus impact, bulk-remove with per-edit revert, batch
  reinstate (\`/feedback/calibration/handwavy-phrases/*\`).
- **Watch the AVRI drift system** — current drift flags, per-family
  means, weekly trend (\`/feedback/calibration/avri-drift\`),
  notification rearm history.
- **Re-run the synthetic battery** — \`POST /test/run\` (dev/staging
  only, gated by \`NODE_ENV !== "production"\`) executes all
  ${fixtureCounts.total} fixtures and reports per-cohort distributions plus
  archetype headroom (current score vs. distance to LIKELY-INVALID
  ceiling). This is the same battery that runs in CI; the route is for
  reviewers who want to A/B a config change without a full deploy.

The dev-only fixture-runner endpoint is intentionally gated on
\`NODE_ENV\` rather than on the calibration token so it can never
accidentally run in production even if the token is compromised.

---

## 7. Fixture battery and golden corpus

The synthetic fixture battery in
\`artifacts/api-server/src/routes/test-fixtures.ts\` is the fastest
feedback loop in the calibration system. Every fixture is a real-shaped
report (or close to it) labeled with its tier, its expected composite
range, its expected Engine 2 range, and its expected triage action set.

Current cohort sizes (introspected):

- **\`T1_LEGIT\`** — well-evidenced real reports: **${fixtureCounts.T1_LEGIT}** fixtures
- **\`T2_BORDERLINE\`** — ambiguous reports a human would also struggle with: **${fixtureCounts.T2_BORDERLINE}** fixtures
- **\`T3_SLOP\`** — generated / templated noise: **${fixtureCounts.T3_SLOP}** fixtures
- **\`T4_HALLUCINATED\`** — fabricated evidence (round addresses, fake CVEs, impossible HTTP): **${fixtureCounts.T4_HALLUCINATED}** fixtures
- **Total**: **${fixtureCounts.total}** fixtures

Every \`T4\` fixture additionally carries a \`condemnedBy\` hint that
names which engine the project relies on to reject that fabrication
shape. The hint is asserted in
\`hallucination-detector-cohort.test.ts\`, so a \`T4\` tagged
\`HallucinationDetector\` that no longer accumulates moderate-tier
weight will fail the suite instead of silently degrading.

Beyond the synthetic battery, the platform also calibrates against a
*real-reports sourcing* corpus described in
\`artifacts/api-server/docs/calibration/2026-05-02-real-reports-sourcing.md\`.
That corpus is the ground truth the synthetic battery is *aimed at*;
the synthetic fixtures are not a substitute for production data on
ratio-tuning decisions (see the AVRI-blend calibration doc for the
precise statement of that constraint).

The dataset loader (\`src/lib/engines/dataset-loader.ts\`) is the entry
point that streams curated real-shaped reports into the calibration
system without requiring them to be checked into the repo.

---

## 8. Known limitations

This section is hand-written and intentionally complete. If you find a
limitation that should be on this list and isn't, open an issue.

- **Per-signal precision/recall is not yet exposed publicly.** The
  per-signal precision and recall numbers exist internally and feed
  the calibration reports, but the public results page does not yet
  show "this signal fired with X% precision on the last
  N reports." (Roadmap: Task #614.)
- **No score confidence interval on the public surface.** The composite
  score is a point estimate. There is no CI band displayed even when
  the underlying score-fusion has high variance. (Roadmap: Task #616.)
- **Cohort baseline ribbon is missing on the public results page.**
  When a report scores 62, there is no on-page comparison to "62 is the
  35th percentile of \`INJECTION\` family this week." (Roadmap:
  Task #615.)
- **No user-tweakable sensitivity slider.** Submitters cannot shift the
  triage thresholds for their own integration. The thresholds in
  \`scoring-config.ts\` are platform-wide. (Roadmap: Task #627.)
- **No public MCP server.** Public AI-agent integration is via the
  three-call REST loop documented in \`/agents.md\`. The MCP server
  that mirrors this surface as Model Context Protocol tools is on the
  roadmap (see §9 — APIs / SDKs / integrations). It does not yet
  exist.
- **No language SDKs.** Integrators are talking raw HTTP today. Python,
  Go, and Rust SDKs are roadmapped (see §9 — APIs / SDKs /
  integrations). The OpenAPI spec is the only generator-ready
  artifact.
- **LLM rewrite prompt is documentation-only.** The prompt published at
  \`docs/marketing/2026-05-02-llm-rewrite-prompt.md\` is a recipe, not
  an endpoint. We deliberately do not host an LLM rewriter on the
  platform.
- **AVRI ratio is calibrated against a partial production corpus.** The
  current \`avriWeight = 0.5\` blend is held pending two weeks of
  post-flip production traces with \`avriBreakdown\` populated; the
  re-evaluation date is 2026-05-13 (see the calibration doc for the
  exact queries to re-run).
- **No engine version pinning per report yet.** Each report is scored
  with the engine version current at the moment of submission. There
  is no stored "this report was scored with engine v3.10.0 substance
  rubric vN" pin that survives engine upgrades. The scoring-config
  version is pinned (${scoringConfigVersion}); engine code version is
  not yet. (Roadmap: Task #624.)
- **Multilingual input is not yet first-class.** The pipeline runs
  end-to-end on non-English reports, but the Engine 1 perplexity model
  and the LLM-slop phrase corpus are English-tuned. Non-English reports
  may score artificially "less suspicious" on Engine 1 simply because
  the perplexity baseline doesn't fit. (Roadmap: Task #696.)
- **No public webhook system.** Integrators that want push-style
  delivery of analysis completion (vs. polling \`GET /reports/{id}\`)
  are not yet supported. (Roadmap: Task #678.)
- **No first-run onboarding tour for the public site.** First-time
  visitors are dropped into the submission card without a guided tour
  of what each engine output means. (Roadmap: Task #647.)
- **No status / uptime page.** Service health is observable via
  \`GET /healthz\` but there is no public timeline of incidents.
  (Roadmap: Tasks #706 / #707.)

---

## 9. Roadmap pointers

The full list of roadmapped work lives in the project task system.
Pointers from this document into that system, grouped by theme, so you
can find work-in-flight related to anything you read above:

- **Metric exposure** — Tasks #614 (per-signal P/R panel), #615
  (cohort baseline ribbon), #616 (score CI), #617 (drift transparency
  widget), #618 (per-CWE FPR dashboard), #619 (signal correlation
  matrix), #620 (score stability monitor), #621 (score evolution
  timeline), #622 (verification trust panel), #623 (per-engine radar
  chart), #624 (engine version pinning), #625 (latency distribution),
  #626 (public corpus stats).
- **User-tweakable controls** — Tasks #627 (sensitivity slider), #628
  (per-signal mute/boost), #629 (custom redaction rules), #630
  (per-engine on/off), #631 (preset library), #632 (A/B preset
  comparison), #633 (bring-your-own fixture battery), #634 (phrase
  suggestion form).
- **Regression-safety stack** — Tasks #638 (regression golden corpus),
  #639 (shadow scoring), #640 (holdout eval), #641 (pre-merge gate),
  #642 (prompt-injection fixtures), #643 (multilingual battery), #644
  (cross-AI-agent pattern detector).
- **Education and onboarding** — Tasks #646–#660 cover the
  How-it-works page, methodology whitepaper, sample gallery,
  glossary, FAQ, quickstart, keyboard shortcuts, accessibility
  statement, architecture diagram, scoring playground, per-engine
  deep-dives, per-signal explainers, CWE reference.
- **APIs / SDKs / integrations** — Tasks #664–#684 cover the
  embeddable score badge and gallery, dynamic OG cards, iframe
  results widget, MCP server, Python/Go/Rust SDKs, Postman
  collection, webhook system, GitHub Action, Slack bot, Discord
  bot, VS Code extension, browser extension, bookmarklet, and
  per-platform integration recipes (HackerOne, Bugcrowd, Intigriti,
  Jira), self-hosted deployment doc, Helm chart.
- **Marketing / community** — Tasks #685–#702 cover blog posts,
  video script, case-study template, pricing/roadmap/showcase/press
  pages, community + contributor guide, testimonials, trust badges,
  and outreach templates. Task #704 (LLM rewrite prompt + doc) is
  merged.
- **Site / ops polish** — Tasks #706–#717 cover status page,
  incident history, security disclosure, threat model doc, sitemap +
  robots, RSS feeds, dark/light theme toggle, print-friendly
  results, i18n scaffold, Markdown report export, inline signal
  heatmap. Task #718 is the wave-closing v3.11 + v3.12 changelog
  drafted *after* the rest of the wave lands.

If a section above named a roadmap task, that task's plan file lives
under \`.local/tasks/\` and contains the scoped "done looks like" for
that piece of work. The task numbers above are stable refs in the
project tasks system.

---

## Regenerating this document

Run from the repo root:

\`\`\`bash
node scripts/regenerate-state-of-platform.mjs
\`\`\`

The script has no external dependencies and is safe to run before
\`pnpm install\`. It re-introspects:

- All operations from \`lib/api-spec/openapi.yaml\`
- All AVRI families and their gold-signal / absence-penalty counts
  from \`artifacts/api-server/src/lib/engines/avri/families.ts\`
- All fixture cohort counts from
  \`artifacts/api-server/src/routes/test-fixtures.ts\`
- The current scoring-config version from
  \`artifacts/api-server/src/lib/scoring-config.ts\`
- The current app version + release date from
  \`artifacts/vulnrap/src/pages/changelog.tsx\`
- The exported engine functions and the lib-module count

Hand-written narrative (sections 1, 4, 6 partially, 8, 9 in full) lives
inline in the script as JS template strings. Update the narrative there
and re-run; do not edit this generated file directly.

To verify the doc is up to date in CI without writing it, run:

\`\`\`bash
node scripts/regenerate-state-of-platform.mjs --check
\`\`\`

The script exits non-zero if regenerating would change the file.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Strip the time-sensitive "Generated:" header line so --check is not
// driven by the calendar — only by structural changes in the
// introspected sources or the inline narrative.
function stripGeneratedDate(s) {
  return s.replace(/^\*\*Generated:\*\*[^\n]*\n/m, "");
}

function main() {
  const next = buildDocument();
  if (CHECK_ONLY) {
    let current = "";
    try {
      current = fs.readFileSync(OUT, "utf8");
    } catch {
      console.error(`[--check] ${OUT} does not exist; regenerate to create it.`);
      process.exit(2);
    }
    if (stripGeneratedDate(current) !== stripGeneratedDate(next)) {
      console.error(
        `[--check] ${OUT} is out of date. Re-run \`node scripts/regenerate-state-of-platform.mjs\`.`,
      );
      process.exit(1);
    }
    console.log(`[--check] ${OUT} is up to date (date line ignored).`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, next);
  console.log(`Wrote ${OUT} (${next.length} bytes, ${next.split(/\s+/).length} words approx).`);
}

main();
