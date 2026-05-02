# Sourcing real reports for the calibration battery

**Status:** strategy / planning. No code or pipeline changes proposed yet — this
doc captures the options on the table and the tradeoffs so the next sprint can
pick a path with eyes open.

**Author context:** every detector and weight in the system today started life
as a category of report we couldn't explain or a calibration disagreement that
wouldn't go away. The 74-fixture test battery is hand-curated, with slop
carefully constructed to look like the slop we've actually seen — but it's
still slop *we wrote*. The next data-science loop needs reports we didn't
write, submitted by people we don't know, with whatever surface area the actual
world generates.

---

## What "good real report data" looks like

For a report to be useful in the calibration battery it needs:

1. **Provenance** — we need to know where it came from so we can defend the
   label, and so duplicates against a public source don't accidentally enter
   the battery as if they were independent.
2. **A defensible label** — at minimum: T1_LEGIT (verified fix landed),
   T3_SLOP (analyst-rejected with reason), or T2_BORDERLINE (analyst kept it
   in queue but couldn't reproduce). The 6-tier `vulnrapCompositeLabel` enum
   we already use is fine.
3. **Stable text** — no PII, no attacker-controlled redirects, no
   self-referential scoring (a report that mentions VulnRap's own categories
   would poison the audit). Text needs to survive our existing redaction
   pipeline cleanly.
4. **A vulnerability class we already classify** — INJECTION, AUTHN_AUTHZ,
   REQUEST_SMUGGLING, WEB_CLIENT, MEMORY_CORRUPTION, the six new classes added
   in Sprint 13, or FLAT. Reports outside the classified set still have value
   for E1/E3 calibration but won't exercise the AVRI gold-signal path.
5. **Independence** — two reports describing the same CVE in similar prose
   should NOT both go into the battery as separate fixtures. They become a
   single fixture with two captured surfaces, OR one becomes the duplicate-
   detection regression test and the other goes into the battery.

---

## Sourcing options

### Option A — public disclosure datasets

**Sources to consider:**

- **HackerOne hacktivity** (`https://hackerone.com/hacktivity`) — publicly
  disclosed reports. Includes both T1_LEGIT (resolved + bounty paid) and a
  reasonable amount of T3_SLOP (closed as N/A, informative, duplicate). Each
  report already carries a triage outcome we can use as a starting label.
- **Bugcrowd Crowdstream** — same pattern, smaller public corpus.
- **GitHub Security Advisories (GHSA)** — typically T1_LEGIT only; no slop
  exposure. Useful for the legit cohort but doesn't help calibrate the slop
  side.
- **OSV.dev** — aggregator over GHSA + others. Same caveat.
- **CVE Project / NVD descriptions** — too short and too sanitized to drive
  Engine 2 substance scoring. Useful as ground truth for "this is a real
  bug" cross-reference, NOT as a fixture text source.
- **oss-fuzz issue tracker** — public crash traces, mostly real. Useful for
  T1_LEGIT crash-trace fixtures (validates the symbol-rich-trace path is
  actually scoring real ASan/UBSAN/MSan output correctly).
- **Project Zero issue tracker** — small N but very high signal. T1_LEGIT
  with deep technical detail. Excellent for the upper end of the legit
  cohort.

**Pros:** large N, already labeled by triage outcome, public so no licensing
ambiguity for non-commercial calibration use.

**Cons:**
- Survivorship bias on the slop side: HackerOne closes a lot of slop privately;
  the public hacktivity feed is filtered to interesting outcomes.
- Selection bias on the legit side: Project Zero reports look nothing like an
  average T1_LEGIT report from a small VDP.
- Attribution: most platforms require the author's permission to redistribute
  report text. We'd need to cite source URLs and fall back to summaries we
  rewrite ourselves if a fixture turns out to be derivative.
- Re-use risk: if we cite a HackerOne report verbatim in our public fixture,
  any future model trained on our codebase will train on the report text,
  which is unwanted.

**Recommended posture:** use public datasets for the *labels and structural
shape* (what a real INJECTION T1_LEGIT looks like, what a real T3_SLOP rejection
reason reads like) and rewrite the fixture text ourselves from primary
documentation (the original advisory, the upstream commit, the test case that
landed). This gives us calibration-relevant fixtures without redistributing
someone else's report verbatim.

### Option B — solicit submissions through `/check`

The Check page already accepts arbitrary report text and runs it through the
full scoring pipeline without storing anything in the database. We could ship
an opt-in "include this report in our calibration battery" checkbox on the
Check page, alongside an explicit consent block:

> ☐ Allow VulnRap to retain the redacted text of this report for use in our
>   public calibration battery. We will:
>   - Keep only the redacted version (PII, secrets, hostnames stripped).
>   - Tag it with the triage outcome you select below.
>   - Cite no identifying information about you or your program.
>   - Remove it on request at any time.

**Pros:**
- Reports come from the actual user base of VulnRap, which is exactly the
  population we want to calibrate against.
- Consent is explicit and the audit trail is clean.
- Triage outcome can be self-reported by the submitter (the analyst who
  rejected/approved the report), which is the strongest possible label.

**Cons:**
- Adoption rate will be low — most submitters won't opt in.
- Reviewer time: every opt-in submission needs a human reviewer to confirm
  the redaction was clean, the label is defensible, and the report doesn't
  duplicate something already in the battery.
- Bias: the population of reviewers willing to opt in is not representative
  of all reviewers.

**Recommended posture:** ship the consent flow but don't expect volume. Treat
opt-in submissions as a high-value trickle, not a primary corpus source.

### Option C — partnerships with VDPs

Direct outreach to a small number of VDP operators (3–5) to share an
anonymized sample of their intake under NDA, in exchange for early access to
audit telemetry against that intake. The exchange is concrete: they get an
analysis of where their intake hides slop from automated triage; we get a
labeled sample to fold into the calibration battery (with their attribution
preferences honored).

**Pros:**
- Highest signal source: a curated 50–100 reports from a real VDP intake will
  surface more new detector categories than 5,000 public hacktivity reports.
- Long-term relationship: a VDP that contributes to the battery has standing
  to ask for detector tweaks against their specific failure modes.

**Cons:**
- Slow: outreach, NDAs, redaction review per partner. First useful fixture
  could be 2–3 sprints out.
- Fragile: a single partner pulling out can compromise a meaningful slice of
  the battery.
- Legal: NDAs need to permit derivative-work calibration weights without
  permitting redistribution of the underlying reports.

**Recommended posture:** worth doing in parallel with Option A as the
medium-term play. Identify 1–2 friendly VDPs (open-source projects with a
disclosed `security.txt` and a public response history) and start there.

### Option D — synthetic generation with controlled labels

Use an LLM to generate slop reports under a controlled prompt that varies
specific signals (e.g. "generate a SQL injection report that names a real CWE
but provides no payload" or "generate an XSS report with a fabricated HTTP
response containing a literal payload"). Each generated report comes with a
ground-truth label and a manifest of which detectors *should* fire.

**Pros:**
- Fast: hundreds of fixtures per hour.
- Labeled by construction.
- Surfaces specific failure modes by design (we know what we're looking for
  before we generate).

**Cons:**
- Doesn't surface failure modes we *aren't* looking for — by definition, the
  prompt only generates what we asked for.
- Risks training a detector against the generator: if we use gpt-5-nano to
  generate slop and gpt-5-nano to score slop, we may be measuring the
  generator's blind spots rather than the detector's.
- Synthetic reports have a recognizable "voice" that differs from real slop;
  the substance-prompt audit (Task #446) was triggered by exactly this
  problem on the legit side.

**Recommended posture:** keep using synthetic fixtures for *targeted regression
tests* (slop-13, slop-14, slop-15 are all of this shape and they earned their
keep) but never as the primary calibration source. A new synthetic fixture
should always answer the question "what specific detector behavior am I
locking in?" — never "is the system improving overall?"

---

## Privacy and legal considerations

Independent of source, every real report entering the battery must:

1. Pass through the existing redaction pipeline, then have a human reviewer
   confirm the redaction was clean (specifically: no email addresses, no IP
   addresses outside the well-known reserved ranges, no internal hostnames,
   no API keys, no real names).
2. Carry a `provenance` field naming the source (HackerOne report URL, GHSA
   advisory id, "submitted via /check on YYYY-MM-DD with consent v1", or
   "partner redacted intake v1").
3. Be removable on request — the fixture file format should support a
   `removal_token` so a cited source can request takedown without
   re-deriving the entire battery.

Current battery format
(`artifacts/api-server/src/lib/engines/test-fixtures/`) doesn't have a
provenance field yet. Adding one before any real-report ingestion lands is a
prerequisite, not a follow-up.

---

## Pipeline: how a real report enters the battery

Proposed flow for any source:

1. **Intake** — report text + label + provenance arrive in a quarantine
   directory (`artifacts/api-server/src/lib/engines/test-fixtures/quarantine/`).
2. **Redaction pass** — run through the existing redaction pipeline; human
   reviewer confirms.
3. **Duplicate check** — score against the existing battery. If
   document-level Jaccard > 0.6 against any existing fixture, flag for
   manual decision (replace? keep both? merge?).
4. **Audit telemetry pre-flight** — score the candidate fixture and confirm
   the existing detectors behave the way the proposed label suggests they
   should. If a T3_SLOP candidate scores 80, either the label is wrong or
   the detectors have a gap. Either way the candidate doesn't enter the
   battery without resolving the disagreement first.
5. **Promotion** — once redaction + dedup + audit pre-flight are clean,
   the fixture file moves from `quarantine/` to its final location with
   a provenance front-matter block.
6. **Calibration replay** — the next `/api/test/run` includes the new
   fixture. Cohort aggregates surface any cohort-level shift.

---

## Recommended next-sprint scope

If we pick this up next sprint, the smallest useful slice is:

1. **Add `provenance` to the fixture format.** No real reports yet — just the
   schema and a migration that backfills existing fixtures with
   `{ source: "hand-curated", author: "vulnrap-team", added: "<sprint>" }`.
2. **Ship the Check-page opt-in consent flow.** Database table for opt-in
   submissions, review queue endpoint (reviewer-only), and a single weekly
   manual review. Expected volume: 0–5 submissions per week initially.
3. **Pick one public source for a one-off ingestion.** Recommend oss-fuzz —
   smallest legal surface, highest detector relevance (real ASan/UBSAN
   traces against the SYMBOL_RICH_TRACE / structural-fabrication paths). Take
   10 reports, run them through the proposed pipeline end-to-end, and
   document what broke.

Steps 1–2 are scoped, low-risk plumbing. Step 3 is the load-bearing
experiment that tells us whether the pipeline is right before we scale it.

The synthetic-fixture pattern continues unchanged in parallel for targeted
regression tests.
