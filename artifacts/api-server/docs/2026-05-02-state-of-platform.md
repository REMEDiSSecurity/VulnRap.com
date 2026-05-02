# State of the Platform — VulnRap

**Generated:** 2026-05-02 (regenerate with `node scripts/regenerate-state-of-platform.mjs`)
**App version at generation:** 3.10.0 (released 2026-05-02)
**Scoring-config version at generation:** 1.0.0
**Endpoints introspected from:** `lib/api-spec/openapi.yaml` — 40 operations
**AVRI families introspected from:** `artifacts/api-server/src/lib/engines/avri/families.ts` — 9 families
**Fixture battery introspected from:** `artifacts/api-server/src/routes/test-fixtures.ts` — 77 fixtures
**Backend lib modules:** 63 non-test `.ts` files in `artifacts/api-server/src/lib/`

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
(`artifacts/vulnrap/`) talking to a single Express + PostgreSQL +
Drizzle backend (`artifacts/api-server/`) over an OpenAPI-described
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
behind `POST /reports` and `POST /reports/check`. There is no async
worker; submissions block on the analysis. The order below is the
order of execution in
`artifacts/api-server/src/lib/engines/index.ts` and
`artifacts/api-server/src/routes/reports.ts`:

1. **Auto-redaction** (`src/lib/redactor.ts`) — strip PII, secrets,
   company names. Result: redacted text + redaction summary.
2. **Section parser** (`src/lib/section-parser.ts`) — split into
   canonical report sections (Title, Summary, Affected, Steps,
   Observed, Expected, Mitigation) for fingerprinting.
3. **Signal extraction** (`src/lib/engines/extractors.ts`) — emits
   the unified `ExtractedSignals` record consumed by all three
   engines (CVE refs, code blocks, file paths, sanitizer traces, raw
   HTTP, claimed CWEs, claim density, paragraph hashes, ...).
4. **AVRI family classification**
   (`src/lib/engines/avri/classify.ts`) — pick the rubric this
   report should be graded against, falling back to `FLAT` when no
   family fingerprint dominates.
5. **Engine 1 — Linguistic** (`engines.ts:runEngine1`) — perplexity,
   handwavy phrase density, AI-self-disclosure, template-fingerprint
   match, fabricated-patch penalty, claim specificity.
6. **Engine 2 — AVRI substance** (`engines.ts:runEngine2` +
   `engines/avri/engine2-avri.ts`) — family-aware gold-signal points
   and absence penalties, fabricated-evidence flags
   (`fabricated-evidence-flags.ts`), substance gate, raw-HTTP sanity
   checks (`engines/avri/raw-http.ts`), crash-trace integrity
   (`engines/avri/crash-trace.ts`), template-campaign detector,
   velocity / replica-id signals, and the family-agnostic slop
   penalties in `engines/avri/slop-signals.ts` (currently
   1 exported penalty function).
7. **Engine 3 — CWE coherence** (`engines.ts:runEngine3` +
   `engines/cwe-fingerprints.ts` + `engines/avri/coherence.ts`) —
   compare claimed CWE against the evidence shape, fire
   `AVRI_FAMILY_CONTRADICTION` and `AVRI_NO_GOLD_SIGNALS` where
   applicable.
8. **LLM gate** (`src/lib/llm-slop.ts`) — deterministic predicate
   that decides whether the LLM call is *worth* its cost given the
   composite signal so far. The LLM is *not* an engine; it is a refiner
   on the substance score, and the gate prevents spending tokens on
   rows that already have a clear answer.
9. **Active verification** (`src/lib/active-verification.ts` +
   `factual-verification.ts`) — live NVD / GitHub / registry checks.
   Backed by the PostgreSQL cache in `cache-service.ts`.
10. **Similarity** (`src/lib/similarity.ts`) — MinHash + LSH,
    Simhash, exact SHA-256, section fingerprints.
11. **Score fusion** (`src/lib/score-fusion.ts`) — combine engine
    votes into the composite, apply the fabrication boost, clamp to
    `[floor, ceiling]` from the active scoring config (current
    version: 1.0.0).
12. **Triage recommendation** (`src/lib/triage-recommendation.ts`) —
    map composite tier × verification outcome × similarity outcome to
    one of: `AUTO_CLOSE`, `MANUAL_REVIEW`, `CHALLENGE_REPORTER`,
    `PRIORITIZE`, `STANDARD_TRIAGE`.
13. **Persistence** — only on `POST /reports` (the `/reports/check`
    path is non-storing). Stores redacted text *iff* the submitter
    chose `contentMode=full`; otherwise only fingerprints and the
    composite trace are persisted.

The exported engine functions in `engines.ts` are:
`runEngine1`, `runEngine2`, `runEngine3`, `computeComposite`.

---

## 3. Signal catalog

The two large signal vocabularies are the **AVRI family rubrics**
(per-family gold signals + absence penalties) and the **family-agnostic
slop signals** that fire across all rubrics. Both are introspected
below from source.

### AVRI families (Engine 2 substrate)

| Family id | Display name | Verification mode | Gold signals | Absence penalties |
| --------- | ------------ | ----------------- | -----------: | ----------------: |
| `MEMORY_CORRUPTION` | Memory corruption / unsafe C | `SOURCE_CODE` | 8 | 3 |
| `INJECTION` | Injection (SQLi / Command / LDAP / NoSQL) | `ENDPOINT` | 6 | 2 |
| `WEB_CLIENT` | Web client (XSS / CSRF / clickjacking / open redirect) | `ENDPOINT` | 11 | 2 |
| `AUTHN_AUTHZ` | Authentication / Authorization / Session | `ENDPOINT` | 6 | 2 |
| `CRYPTO` | Cryptography | `SOURCE_CODE` | 5 | 2 |
| `DESERIALIZATION` | Insecure deserialization / unsafe parsing | `SOURCE_CODE` | 8 | 2 |
| `RACE_CONCURRENCY` | Race condition / TOCTOU / concurrency | `MANUAL_ONLY` | 6 | 2 |
| `REQUEST_SMUGGLING` | HTTP request smuggling / desync / parser confusion | `MANUAL_ONLY` | 5 | 2 |
| `FLAT` | Generic / unclassified | `GENERIC` | 4 | 0 |

The per-family reproduction expectation that AVRI grades against:

- **`MEMORY_CORRUPTION` — Memory corruption / unsafe C**: Memory corruption requires a sanitizer trace OR a debugger/coredump session showing the bad write/read.
- **`INJECTION` — Injection (SQLi / Command / LDAP / NoSQL)**: Injection requires the exact payload and target parameter (e.g. POST /login with email='test' OR 1=1--).
- **`WEB_CLIENT` — Web client (XSS / CSRF / clickjacking / open redirect)**: Web-client issues need the payload, the vulnerable endpoint/parameter, and proof of execution (alert/console.log/cookie exfil).
- **`AUTHN_AUTHZ` — Authentication / Authorization / Session**: Authn/authz reports must show two distinct sessions/accounts and the exact request that crosses the boundary.
- **`CRYPTO` — Cryptography**: Crypto findings need the algorithm/mode, the misuse pattern (static IV, weak hash, etc.), and ideally a KAT or observable break.
- **`DESERIALIZATION` — Insecure deserialization / unsafe parsing**: Deserialization findings need the gadget/payload, the deserialization sink (with library), and proof of execution or sensitive read.
- **`RACE_CONCURRENCY` — Race condition / TOCTOU / concurrency**: Race conditions need two interleaved actors and a measurable observable (sanitizer, double-spend, duplicate row, etc.).
- **`REQUEST_SMUGGLING` — HTTP request smuggling / desync / parser confusion**: Smuggling reports must show the raw HTTP bytes (CRLF preserved), the parser disagreement, and the smuggled request that lands on the backend.
- **`FLAT` — Generic / unclassified**: Provide step-by-step reproduction with exact inputs and observed outputs.

The total substrate is **59 gold-signal patterns** and
**17 absence-penalty patterns** across
9 families. The `FLAT` family is the catch-all for reports
whose CWE classification is unknown or contested; it is deliberately
shallow so that "we don't know what this is" doesn't get scored as
"this passes."

#### Per-family signal inventory (every signal id with description)

The full per-family rubric is enumerated below — every `goldSignals[].id`
and `absencePenalties[].id` from `families.ts`, with its description
and point value. The regex pattern that backs each signal lives in the
source; the doc lists the human-readable contract.

#### `MEMORY_CORRUPTION` — Memory corruption / unsafe C

Verification mode: `SOURCE_CODE`. Gold signals: 8. Absence penalties: 3.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `asan_or_sanitizer` | AddressSanitizer / MSan / UBSan / TSAN crash output | +22 |
| `valgrind` | Valgrind error trace | +18 |
| `stack_trace_with_offset` | Crash stack trace with hex offsets | +12 |
| `specific_alloc_function` | Reference to specific allocator function (malloc/calloc/strdup/g_malloc/free) | +8 |
| `memory_op_with_size` | memcpy/memmove/strncpy/snprintf with explicit size | +8 |
| `specific_struct_field` | Specific C struct field access (e.g. obj->buf, ptr->len) | +6 |
| `code_diff_in_c` | Diff/patch hunk against a .c/.h/.cpp file | +12 |
| `cwe_correct_class` | Mentions CWE-119/120/121/122/125/787/416/590/672/762 | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_crash_or_sanitizer` | No sanitizer/valgrind crash output | −8 |
| `no_size_or_offset` | No explicit byte/size/offset value | −5 |
| `no_c_source_reference` | No C/C++ source file reference | −5 |


#### `INJECTION` — Injection (SQLi / Command / LDAP / NoSQL)

Verification mode: `ENDPOINT`. Gold signals: 6. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `concrete_payload` | Concrete injection payload | +22 |
| `vulnerable_query_construction` | Shows the unsafe query/exec construction | +14 |
| `request_response_diff` | Side-by-side normal vs injected request showing differing behavior | +10 |
| `specific_endpoint_param` | Names a specific endpoint + parameter | +8 |
| `cwe_correct_class` | Mentions CWE-89/77/78/91/943/917 | +4 |
| `code_diff_for_fix` | Diff showing parameterized fix | +6 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_payload` | No concrete injection payload | −12 |
| `no_endpoint` | No specific URL or endpoint named | −6 |


#### `WEB_CLIENT` — Web client (XSS / CSRF / clickjacking / open redirect)

Verification mode: `ENDPOINT`. Gold signals: 11. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `concrete_payload` | Concrete XSS/JS payload | +22 |
| `reflection_or_dom_proof` | Shows the response/DOM where the payload is reflected | +12 |
| `specific_dom_sink` | Names a specific DOM sink/source | +10 |
| `endpoint_with_param` | Specific endpoint and reflected parameter | +8 |
| `csrf_specific_request` | (CSRF) shows the cross-origin request being forged | +8 |
| `ssrf_internal_metadata` | Concrete cloud-metadata or RFC1918 SSRF target URL | +20 |
| `path_traversal_payload` | Concrete path-traversal payload reaching a sensitive file | +18 |
| `ssrf_or_traversal_sink` | Sink that fetches a URL or reads a file from user input | +8 |
| `code_diff_for_fix` | Diff/patch hunk | +10 |
| `file_with_line` | File path with line number reference | +6 |
| `cwe_correct_class` | Mentions a WEB_CLIENT-family CWE | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_payload` | No concrete XSS/CSRF/redirect/SSRF/traversal payload | −10 |
| `no_url` | No real URL or endpoint | −4 |


#### `AUTHN_AUTHZ` — Authentication / Authorization / Session

Verification mode: `ENDPOINT`. Gold signals: 6. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `two_account_proof` | Demonstrates access between two distinct accounts/users | +16 |
| `authorization_header_swap` | Shows swapping authorization headers/tokens | +12 |
| `idor_object_id` | Shows changing an object id to access another resource | +10 |
| `specific_endpoint` | Names a specific authenticated endpoint | +8 |
| `policy_or_check_function` | References specific authz policy/check function | +6 |
| `cwe_correct_class` | Mentions CWE-285/287/306/639/862/863/284 | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_two_account_proof` | No proof that ≥2 accounts/sessions are involved | −8 |
| `no_endpoint` | No protected endpoint named | −5 |


#### `CRYPTO` — Cryptography

Verification mode: `SOURCE_CODE`. Gold signals: 5. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `specific_algo_or_lib` | Names a specific algorithm/mode/library | +14 |
| `kat_or_test_vector` | Provides KAT/test vector/known plaintext-ciphertext pair | +12 |
| `specific_misuse` | Names a specific misuse pattern | +10 |
| `code_reference` | Specific source/file reference for crypto call | +8 |
| `cwe_correct_class` | Mentions CWE-327/328/330/338/759/760/916 | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_algo_named` | No specific algorithm/mode named | −8 |
| `no_kat` | No test vector / observable misuse demonstration | −6 |


#### `DESERIALIZATION` — Insecure deserialization / unsafe parsing

Verification mode: `SOURCE_CODE`. Gold signals: 8. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `concrete_gadget_or_payload` | Concrete gadget chain/payload (ysoserial, marshalsec, pickle, yaml.load) | +18 |
| `exec_or_rce_evidence` | Shows arbitrary code/command execution result | +12 |
| `specific_class_or_lib` | Names a specific deserialized class/library | +8 |
| `code_reference` | Source code showing the deserialization sink | +8 |
| `xxe_doctype_entity` | Concrete XXE DOCTYPE/ENTITY declaration with file:/http: URI | +18 |
| `xml_parser_lib` | Specific XML parser library/API | +10 |
| `xxe_entity_load_flag` | Parser flag enabling external entity loading | +12 |
| `cwe_correct_class` | Mentions CWE-502/611/776/827 | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_payload_or_gadget` | No payload or gadget chain shown | −10 |
| `no_lib_named` | No specific library/format named | −6 |


#### `RACE_CONCURRENCY` — Race condition / TOCTOU / concurrency

Verification mode: `MANUAL_ONLY`. Gold signals: 6. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `two_thread_or_request_proof` | Shows two interleaved threads/requests/transactions | +14 |
| `tsan_or_helgrind` | ThreadSanitizer / Helgrind / DRD output | +16 |
| `lock_or_atomic_reference` | References a specific lock/mutex/atomic primitive | +8 |
| `filesystem_toctou` | (File-TOCTOU) shows access(2)/stat(2) followed by open(2) | +10 |
| `specific_function` | Names the specific racing function/handler | +6 |
| `cwe_correct_class` | Mentions CWE-362/363/364/367/833 | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_concurrent_proof` | No demonstration of two interleaved actors | −10 |
| `no_function_or_path` | No specific function/file path named | −5 |


#### `REQUEST_SMUGGLING` — HTTP request smuggling / desync / parser confusion

Verification mode: `MANUAL_ONLY`. Gold signals: 5. Absence penalties: 2.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `raw_http_request` | Raw HTTP/1.1 request bytes with explicit headers | +18 |
| `te_or_cl_conflict` | Both Transfer-Encoding and Content-Length present (TE.CL/CL.TE) | +14 |
| `smuggled_second_request` | Shows the smuggled second request (e.g. GPOST / on a new pipeline) | +12 |
| `specific_proxy_or_server` | Names the specific proxy/server combo | +8 |
| `cwe_correct_class` | Mentions CWE-444/436/116 | +4 |

**Absence penalties (deducted when missing):**

| Signal id | Description | Penalty |
| --------- | ----------- | ------: |
| `no_raw_request` | No raw HTTP request bytes provided | −10 |
| `no_proxy_named` | No specific proxy/server identified | −6 |


#### `FLAT` — Generic / unclassified

Verification mode: `GENERIC`. Gold signals: 4. Absence penalties: 0.

**Gold signals (added when present):**

| Signal id | Description | Points |
| --------- | ----------- | -----: |
| `code_block` | Any fenced code block ≥3 lines | +10 |
| `real_url` | Real URL with path | +6 |
| `file_with_line` | File path with line number | +8 |
| `code_diff` | Diff/patch hunk | +12 |


### Family-agnostic slop signals

The penalties in `src/lib/engines/avri/slop-signals.ts` (currently
1 function) catch shapes that cut across families
— e.g. "claims to be a patch but contains no diff hunk or code block"
— and apply *after* family scoring so a report cannot escape a
cross-family slop pattern by being classified into a family whose
rubric happens not to require that evidence.

### Other indicator codes worth knowing

These are produced by various engine paths and surfaced in the trace:

- `HALLUCINATION_FABRICATED_EVIDENCE` — Engine 2 / hallucination
  detector (`src/lib/hallucination-detector.ts`). Round addresses,
  magic PIDs, repeated stack frames, impossible HTTP shapes.
- `AVRI_FAMILY_CONTRADICTION` — Engine 3. The classified family
  contradicts a phrase in the report (e.g. `<script>` inside a
  `MEMORY_CORRUPTION` classification).
- `AVRI_NO_GOLD_SIGNALS` — Engine 2. The chosen family's rubric
  produced zero gold-signal hits.
- `AVRI_FABRICATED_PATCH` — Slop-signals. Patch claim with no real
  diff or code block.
- `AVRI_TEMPLATE_CAMPAIGN` / `AVRI_REPLICA_ID` / `AVRI_VELOCITY`
  — Engine 2 cross-report signals (template fingerprint, replica id,
  submission velocity).
- `SUBSTANCE_GATE` — Score-fusion. The Engine 2 result is the
  substance gate; if substance is below the gate threshold, the
  composite is held at the lower tier even if Engine 1 wants to lift
  it.
- `CRASH_TRACE_*` / `RAW_HTTP_*` — Engine 2 sub-detectors with
  per-family gating (only fire when the family expects that evidence
  shape).

Every indicator code that can fire is asserted by at least one test in
`artifacts/api-server/src/`; `hallucination-detector-cohort.test.ts`
in particular pins which engine condemns each `T4` fixture so a
fixture that silently stops being condemned by its expected engine
fails the suite loudly.

---

## 4. Calibration and drift monitoring

VulnRap calibrates against three things: the synthetic fixture battery
in `test-fixtures.ts` (every commit), feedback collected on real
submissions (continuous), and rolling production AVRI traces
(weekly review).

The synthetic battery is the fast feedback loop. It runs in CI and
every fixture asserts an expected composite range, an expected Engine 2
range, and an expected triage action set. A regression in any one of
the three dimensions fails the suite. The doc
`artifacts/api-server/docs/calibration/2026-04-30-avri-blend-calibration.md`
captures the most recent ratio decision (the `avriWeight = 0.5`
substance/legacy blend held at Sprint 12 pending production trace
accumulation; re-evaluation scheduled 2026-05-13).

Feedback-driven calibration is in `src/lib/calibration.ts` plus the
calibration routes under `/api/feedback/calibration/*`. A reviewer
solves the proof-of-work challenge (`src/lib/challenge.ts`),
authenticates with the calibration token, and walks through suggested
weight changes generated by analyzing the feedback corpus against the
scoring outputs. Volume gating ensures suggestions are only made when
enough feedback exists to be meaningful.

The AVRI drift system (`src/lib/avri-drift.ts` and
`src/lib/avri-drift-notifications.ts`) provides the rolling
production view. It buckets each week's reports by triage outcome (T1
vs T3 equivalents), computes per-family means of the AVRI composite,
and fires drift flags when the rubric collapses or a family's weight
diverges from its calibrated baseline. The
`/feedback/calibration/avri-drift` endpoint surfaces the same view
publicly (read-only). A separate notifications webhook
(`/feedback/calibration/avri-drift/notifications`) lets the team get
alerted when a new drift flag arms; rearm history is kept so a noisy
flag doesn't keep paging.

The handwavy-phrase calibration
(`/feedback/calibration/handwavy-phrases`) is the workflow for
adding/removing the LLM-detection phrases that feed into Engine 1's
template-fingerprint signal. It supports batched removals, per-edit
revert, and a dry-run preview so reviewers can see the corpus impact
before applying a change.

The scoring-config version (current: 1.0.0) is the
header that pins every analysis output to the configuration that
produced it — so an older trace can be re-scored under a newer config
without losing the original verdict, and the drift flags can be
attributed to a specific config window.

---

## 5. Public API surface

Introspected from `lib/api-spec/openapi.yaml` — total
40 operations across the public surface. The base path
is `/api`. All endpoints are public except calibration write paths,
which require the reviewer token described in
`docs/calibration-reviewer-token.md`.

#### Tag: `health` (1 operation)

| Method | Path | operationId | Summary |
| ------ | ---- | ----------- | ------- |
| `GET` | `/healthz` | `healthCheck` | Health check |

#### Tag: `reports` (9 operations)

| Method | Path | operationId | Summary |
| ------ | ---- | ----------- | ------- |
| `POST` | `/reports` | `submitReport` | Submit a vulnerability report for analysis |
| `GET` | `/reports/{id}` | `getReport` | Get report analysis results |
| `DELETE` | `/reports/{id}` | `deleteReport` | Delete a previously submitted report |
| `GET` | `/reports/{id}/verify` | `getVerification` | Get verification badge data for a report |
| `GET` | `/reports/{id}/compare/{matchId}` | `compareReports` | Compare two reports side by side |
| `GET` | `/reports/{id}/triage-report` | `getTriageReport` | Get exportable markdown triage report |
| `POST` | `/reports/check` | `checkReport` | Check a report against the database without storing it |
| `GET` | `/reports/lookup/{hash}` | `lookupByHash` | Look up a report by content hash |
| `GET` | `/reports/feed` | `getReportFeed` | Get recent public reports |

#### Tag: `feedback` (24 operations)

| Method | Path | operationId | Summary |
| ------ | ---- | ----------- | ------- |
| `GET` | `/feedback/challenge` | `getFeedbackChallenge` | Get a proof-of-work challenge for feedback submission |
| `POST` | `/feedback` | `submitFeedback` | Submit user feedback about the tool |
| `GET` | `/feedback/analytics` | `getFeedbackAnalytics` | Get aggregated feedback analytics |
| `GET` | `/feedback/calibration` | `getCalibrationReport` | Get calibration report with tuning suggestions |
| `GET` | `/feedback/calibration/avri-drift` | `getAvriDriftReport` | Get rolling AVRI calibration drift report |
| `GET` | `/feedback/calibration/avri-drift/notifications` | `getAvriDriftNotifications` | List the persisted AVRI drift notification dedup state |
| `POST` | `/feedback/calibration/avri-drift/notifications/rearm` | `rearmAvriDriftNotifications` | Re-arm one or more previously-notified AVRI drift flags |
| `GET` | `/feedback/calibration/avri-drift/scheduler-status` | `getAvriDriftSchedulerStatus` | Get per-replica AVRI drift scheduler status |
| `GET` | `/feedback/calibration/avri-drift/notifications/rearm-history` | `getAvriDriftRearmHistory` | List the persisted AVRI drift re-arm audit log |
| `GET` | `/feedback/calibration/auth-brute-force-alerts` | `getCalibrationAuthBruteForceAlerts` | List recent calibration auth brute-force alert decisions |
| `GET` | `/feedback/calibration/config` | `getScoringConfig` | Get current and historical scoring configurations |
| `GET` | `/feedback/calibration/auth-status` | `getCalibrationAuthStatus` | Probe whether the reviewer token is configured/valid |
| `POST` | `/feedback/calibration/apply` | `applyCalibration` | Apply calibration changes to scoring config |
| `GET` | `/feedback/calibration/handwavy-phrases` | `getHandwavyPhrases` | List the curated FLAT hand-wavy marker phrases |
| `POST` | `/feedback/calibration/handwavy-phrases` | `addHandwavyPhrase` | Append a new FLAT hand-wavy marker phrase |
| `PATCH` | `/feedback/calibration/handwavy-phrases` | `editHandwavyPhrase` | Edit a curated FLAT hand-wavy marker phrase in place |
| `DELETE` | `/feedback/calibration/handwavy-phrases` | `removeHandwavyPhrase` | Remove one or many FLAT hand-wavy marker phrases |
| `GET` | `/feedback/calibration/handwavy-phrases/removal-batches` | `listHandwavyPhraseRemovalBatches` | List recent FLAT hand-wavy phrase BATCH removal entries (picker-friendly summary) |
| `GET` | `/feedback/calibration/handwavy-phrases/removal-batches/{removedAt}` | `getHandwavyPhraseRemovalBatch` | Fetch the FULL inner phrase list for a single batch removal entry |
| `POST` | `/feedback/calibration/handwavy-phrases/undo` | `undoHandwavyPhrase` | Undo a brand-new add of a FLAT hand-wavy marker phrase |
| `POST` | `/feedback/calibration/handwavy-phrases/undo-batch` | `undoHandwavyPhrasesBatch` | Undo every still-in-window FLAT hand-wavy phrase add in one round-trip |
| `POST` | `/feedback/calibration/handwavy-phrases/reinstate-batch` | `reinstateHandwavyPhrasesBatch` | Reinstate every not-yet-reinstated phrase from a single batch removal entry |
| `POST` | `/feedback/calibration/handwavy-phrases/reinstate` | `reinstateHandwavyPhrase` | Reinstate a previously removed FLAT hand-wavy marker phrase from history |
| `POST` | `/feedback/calibration/handwavy-phrases/revert-edit` | `revertHandwavyPhraseEdit` | Revert a single edit on a curated FLAT hand-wavy marker phrase |

#### Tag: `stats` (6 operations)

| Method | Path | operationId | Summary |
| ------ | ---- | ----------- | ------- |
| `GET` | `/stats` | `getStats` | Get platform statistics |
| `GET` | `/stats/recent` | `getRecentActivity` | Get recent submission activity |
| `GET` | `/stats/distribution` | `getSlopDistribution` | Get slop score distribution |
| `POST` | `/stats/visit` | `recordVisit` | Record a page visit |
| `GET` | `/stats/visitors` | `getVisitorStats` | Get visitor statistics |
| `GET` | `/stats/trends` | `getTrends` | Get trend data over time |

Beyond the table, the noteworthy shape facts:

- **`POST /reports`** is the storing path; **`POST /reports/check`**
  is the non-storing dry-run that returns the analysis fields
  (`slopScore`, `slopTier`, `qualityScore`, `breakdown`,
  `evidence`, `similarityMatches`) but no persistence handles —
  no report `id`, no delete token, no triage-report URL — so triage
  pipelines can sample a report against the corpus before deciding to
  submit.
- **`GET /reports/lookup/{hash}`** lets an integrator check whether a
  given SHA-256 of report content has been seen before without
  uploading the content itself.
- **`GET /reports/{id}/triage-report`** returns Markdown ready to
  paste into Jira / ServiceNow / GitHub issue trackers.
- **`GET /reports/{id}/verify`** is the lightweight verification badge
  endpoint — small JSON payload designed to be embedded in bug-bounty
  platform comment threads.
- **`POST /feedback`** requires a solved proof-of-work challenge from
  `GET /feedback/challenge` — this is the spam control on the
  public, no-account feedback path.

---

## 6. Reviewer surface

Beyond the public API, calibration reviewers have a separate UI
mounted in the same `artifacts/vulnrap` SPA, behind the calibration
token gate. The pages live under `/calibration/*` in the frontend and
are served by the same Express app via the
`/feedback/calibration/*` routes.

What reviewers can do:

- **Inspect feedback analytics** — rating distribution, daily trends,
  score-vs-feedback correlation, outlier reports, recent feedback
  entries (`GET /feedback/analytics`).
- **Run the calibration report** — see weight and threshold change
  suggestions with their evidence (`GET /feedback/calibration`),
  apply via `POST /feedback/calibration/apply` (audited).
- **Manage handwavy phrases** — add/remove the LLM-style phrases,
  preview corpus impact, bulk-remove with per-edit revert, batch
  reinstate (`/feedback/calibration/handwavy-phrases/*`).
- **Watch the AVRI drift system** — current drift flags, per-family
  means, weekly trend (`/feedback/calibration/avri-drift`),
  notification rearm history.
- **Re-run the synthetic battery** — `POST /test/run` (dev/staging
  only, gated by `NODE_ENV !== "production"`) executes all
  77 fixtures and reports per-cohort distributions plus
  archetype headroom (current score vs. distance to LIKELY-INVALID
  ceiling). This is the same battery that runs in CI; the route is for
  reviewers who want to A/B a config change without a full deploy.

The dev-only fixture-runner endpoint is intentionally gated on
`NODE_ENV` rather than on the calibration token so it can never
accidentally run in production even if the token is compromised.

---

## 7. Fixture battery and golden corpus

The synthetic fixture battery in
`artifacts/api-server/src/routes/test-fixtures.ts` is the fastest
feedback loop in the calibration system. Every fixture is a real-shaped
report (or close to it) labeled with its tier, its expected composite
range, its expected Engine 2 range, and its expected triage action set.

Current cohort sizes (introspected):

- **`T1_LEGIT`** — well-evidenced real reports: **15** fixtures
- **`T2_BORDERLINE`** — ambiguous reports a human would also struggle with: **10** fixtures
- **`T3_SLOP`** — generated / templated noise: **33** fixtures
- **`T4_HALLUCINATED`** — fabricated evidence (round addresses, fake CVEs, impossible HTTP): **19** fixtures
- **Total**: **77** fixtures

Every `T4` fixture additionally carries a `condemnedBy` hint that
names which engine the project relies on to reject that fabrication
shape. The hint is asserted in
`hallucination-detector-cohort.test.ts`, so a `T4` tagged
`HallucinationDetector` that no longer accumulates moderate-tier
weight will fail the suite instead of silently degrading.

Beyond the synthetic battery, the platform also calibrates against a
*real-reports sourcing* corpus described in
`artifacts/api-server/docs/calibration/2026-05-02-real-reports-sourcing.md`.
That corpus is the ground truth the synthetic battery is *aimed at*;
the synthetic fixtures are not a substitute for production data on
ratio-tuning decisions (see the AVRI-blend calibration doc for the
precise statement of that constraint).

The dataset loader (`src/lib/engines/dataset-loader.ts`) is the entry
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
  35th percentile of `INJECTION` family this week." (Roadmap:
  Task #615.)
- **No user-tweakable sensitivity slider.** Submitters cannot shift the
  triage thresholds for their own integration. The thresholds in
  `scoring-config.ts` are platform-wide. (Roadmap: Task #627.)
- **No public MCP server.** Public AI-agent integration is via the
  three-call REST loop documented in `/agents.md`. The MCP server
  that mirrors this surface as Model Context Protocol tools is on the
  roadmap (see §9 — APIs / SDKs / integrations). It does not yet
  exist.
- **No language SDKs.** Integrators are talking raw HTTP today. Python,
  Go, and Rust SDKs are roadmapped (see §9 — APIs / SDKs /
  integrations). The OpenAPI spec is the only generator-ready
  artifact.
- **LLM rewrite prompt is documentation-only.** The prompt published at
  `docs/marketing/2026-05-02-llm-rewrite-prompt.md` is a recipe, not
  an endpoint. We deliberately do not host an LLM rewriter on the
  platform.
- **AVRI ratio is calibrated against a partial production corpus.** The
  current `avriWeight = 0.5` blend is held pending two weeks of
  post-flip production traces with `avriBreakdown` populated; the
  re-evaluation date is 2026-05-13 (see the calibration doc for the
  exact queries to re-run).
- **No engine version pinning per report yet.** Each report is scored
  with the engine version current at the moment of submission. There
  is no stored "this report was scored with engine v3.10.0 substance
  rubric vN" pin that survives engine upgrades. The scoring-config
  version is pinned (1.0.0); engine code version is
  not yet. (Roadmap: Task #624.)
- **Multilingual input is not yet first-class.** The pipeline runs
  end-to-end on non-English reports, but the Engine 1 perplexity model
  and the LLM-slop phrase corpus are English-tuned. Non-English reports
  may score artificially "less suspicious" on Engine 1 simply because
  the perplexity baseline doesn't fit. (Roadmap: Task #696.)
- **No public webhook system.** Integrators that want push-style
  delivery of analysis completion (vs. polling `GET /reports/{id}`)
  are not yet supported. (Roadmap: Task #678.)
- **No first-run onboarding tour for the public site.** First-time
  visitors are dropped into the submission card without a guided tour
  of what each engine output means. (Roadmap: Task #647.)
- **No status / uptime page.** Service health is observable via
  `GET /healthz` but there is no public timeline of incidents.
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
under `.local/tasks/` and contains the scoped "done looks like" for
that piece of work. The task numbers above are stable refs in the
project tasks system.

---

## Regenerating this document

Run from the repo root:

```bash
node scripts/regenerate-state-of-platform.mjs
```

The script has no external dependencies and is safe to run before
`pnpm install`. It re-introspects:

- All operations from `lib/api-spec/openapi.yaml`
- All AVRI families and their gold-signal / absence-penalty counts
  from `artifacts/api-server/src/lib/engines/avri/families.ts`
- All fixture cohort counts from
  `artifacts/api-server/src/routes/test-fixtures.ts`
- The current scoring-config version from
  `artifacts/api-server/src/lib/scoring-config.ts`
- The current app version + release date from
  `artifacts/vulnrap/src/pages/changelog.tsx`
- The exported engine functions and the lib-module count

Hand-written narrative (sections 1, 4, 6 partially, 8, 9 in full) lives
inline in the script as JS template strings. Update the narrative there
and re-run; do not edit this generated file directly.

To verify the doc is up to date in CI without writing it, run:

```bash
node scripts/regenerate-state-of-platform.mjs --check
```

The script exits non-zero if regenerating would change the file.
