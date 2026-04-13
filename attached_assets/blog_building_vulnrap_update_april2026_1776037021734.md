# Building VulnRap: How We're Making AI Slop Detection Actually Work for PSIRT Teams

*Published April 2026 | vulnrap.com*

---

If you run a PSIRT team or maintain an open-source project with a bug bounty program, you already know the problem. AI-generated vulnerability reports — "slop" — are flooding inboxes at an accelerating rate. The curl project reports that only about 5% of their 2025 submissions were genuine vulnerabilities, with roughly 20% being identifiable AI slop and a growing chunk being "human slop" that's indistinguishable in origin but equally useless. The Log4j team documented 60+ clear slop examples in their YesWeHack program. Node.js received over 30 AI slop reports during a single holiday period.

Each one of these reports costs someone 3-4 hours to triage. For a team of volunteers who might only have three hours per week for the project, a single slop report consumes their entire weekly contribution. It's a denial-of-service attack on open source maintainership, and it's why curl ultimately shut down their bug bounty program in January 2026.

VulnRap was built to solve this. Not by replacing human judgment, but by giving PSIRT teams a way to score, verify, and triage incoming vulnerability reports before burning hours on reports that turn out to be hallucinated nonsense. We've been through four major development sprints since launch, and this post is a detailed walkthrough of what we built, what we learned, what works, and what's coming next.

---

## How This Started: A Weekend Project That Wouldn't Let Go

VulnRap started as a weekend project. That's it — no funding round, no roadmap, no team. Just a frustrated PSIRT engineer who'd spent one too many Friday afternoons triaging a beautifully formatted report about a buffer overflow in a function that didn't exist.

The initial idea was deliberately narrow: "What if I just grep for 'Dear Security Team' and 'I hope this message finds you well' and auto-flag those?" That prototype took about two hours. It caught maybe 30% of the slop in our queue. Good enough to be interesting. Not good enough to be useful.

And that's where the nerd sniping happened.

If you're unfamiliar with the term, "nerd sniping" is [the xkcd concept](https://xkcd.com/356/) where you present someone with a problem so interesting that they can't stop thinking about it. AI slop detection is a textbook nerd snipe: it sits at the intersection of computational linguistics, information retrieval, adversarial machine learning, and the deeply human question of "what does it mean to actually understand a vulnerability?"

The weekend project became a week-long project. The week became a month. Every time I solved one detection problem, I'd find two more. "OK, I can catch AI phrases — but what about the slop that doesn't use AI phrases?" That led to statistical text analysis. "OK, I can detect abnormal sentence uniformity — but what about the slop that references real code?" That led to factual verification via GitHub API. "OK, I can check if functions exist — but what about the slop that references real functions but describes fake vulnerabilities?" That led to the LLM semantic analysis layer.

Each layer was a weekend. Each weekend peeled back another layer of the problem. And each layer revealed that slop detection is fundamentally a game theory problem — you're not building a classifier, you're building a system where every bypass requires doing progressively more real work, until the effort to bypass the detector exceeds the effort to just find a real vulnerability.

The stack reflects the weekend-project origin: Express, React, PostgreSQL, TailwindCSS. Nothing exotic. The entire thing runs on a single Replit instance. We open-sourced it because the problem isn't ours alone — every PSIRT team, every bug bounty program, every open-source maintainer is dealing with this. The more eyes on the detection logic, the better it gets.

---

## Where We Started: The Brutal Baseline

Before we could improve anything, we needed to know how well (or poorly) the original system worked. We ran a blind test: 29 vulnerability reports submitted through the VulnRap API. 14 were known AI slop at varying sophistication levels. 15 were confirmed legitimate — sourced from HackerOne disclosed reports (with real bounty payouts), oss-security mailing list advisories written by researchers like Daniel Stenberg and Qualys, and Full Disclosure advisories from firms like SEC Consult.

The results were sobering.

The mean slop score was 32.6. The mean legitimate score was 32.1. That's a gap of 0.5 points — statistically indistinguishable. Cohen's d effect size was 0.06, which in statistical terms means "negligible." The best achievable accuracy was 58.6%, barely better than a coin flip.

What was happening? The original scoring system was measuring report *quality* — not report *origin*. It checked for things like version numbers, code blocks, affected components, and expected-vs-observed behavior comparisons. A well-structured AI fabrication scored low (looked "good"), while a real but terse kernel developer's bug report scored high (looked "bad"). A fabricated Java deserialization report scored 18 — *lower* than an official libpng CVE advisory that scored 20. A real Alipay vulnerability chain affecting a billion users scored 46, dangerously close to the "highly suspicious" threshold.

The system was penalizing style instead of substance. That had to change.

---

## Sprint 1: Separating Quality from Slop

The single most important architectural decision we made was splitting "report quality" and "slop probability" into entirely separate scoring axes. A report can be well-written AND be AI slop. A report can be terse and informal AND contain a genuine zero-day. These are orthogonal dimensions.

We built a four-axis scoring model:

**Axis 1: Linguistic AI Fingerprinting.** This axis looks for the specific patterns that AI language models produce when generating security reports. Not generic "good writing vs bad writing" — but the actual telltale markers.

We compiled a weighted dictionary of AI-specific phrases drawn from hundreds of real slop submissions. Phrases like "Dear Security Team, I hope this message finds you well" (weight 20), "Certainly! Let me elaborate" (weight 30), "I apologize for any confusion in my previous report" (weight 25), "Upon further analysis using my advanced security tools" (weight 20). These aren't phrases that real vulnerability researchers use. A human might open a report with "hey, found a bug in your parser" — they don't open with "I would like to bring to your attention a potential security vulnerability that I discovered during my thorough security assessment."

Beyond phrase matching, we added statistical text analysis: sentence length coefficient of variation (real humans vary their sentence length; AI produces remarkably uniform sentence lengths) and bigram entropy (AI text has measurably lower entropy in its word-pair distributions than human text). A passive voice ratio check flags the kind of stilted, overly formal construction that LLMs default to.

**Axis 2: Structural Quality (separate from slop).** This axis still evaluates report completeness — does it have version numbers, reproduction steps, a PoC, an impact statement? — but it now feeds into a separate `qualityScore` that does NOT inflate the slop score. A well-structured slop report gets quality=77 and slop=75. A terse but real report gets quality=45 and slop=12. The two numbers tell different stories, and triagers need both.

**Axis 3: Factual Verification.** This is where things get interesting. Can we verify whether the claims in the report are actually true? We check for placeholder URLs (target.com, example.com, vulnerable-server.com, attacker.com in PoC curl commands), for non-existent CVE IDs, for severity inflation (claiming CVSS 9.8 critical for a self-DoS), and for known template patterns. A "Dear Security Team" opener followed by "Steps to Reproduce: 1. Navigate to... 2. Enter the following payload..." followed by "Impact: An attacker could potentially..." is a template. We hash these structures and match them.

**Axis 4: LLM Deep Analysis.** For reports that the heuristic axes can't confidently classify, we pass the text to a language model for semantic analysis. The LLM evaluates specificity (does this report describe something the author actually did?), originality (is this a rewrite of public information or original research?), voice consistency (does the technical depth match the writing style?), coherence (does the narrative hold together or contradict itself?), and hallucination probability (are the technical claims plausible?).

### Sprint 1 Results

We retested with 16 completely fresh reports — no overlap with the original 29. Eight legitimate reports from the oss-security mailing list (OpenSSL, Cockpit RCE, Flatpak sandbox escape, libcap TOCTOU, X41's LiteLLM audit, libpng UAF, CPython base64, Apache Airflow authz bypass). Eight freshly crafted slop at varying sophistication (generic XSS, template SQLi, SSRF cloud, Java deserialization, dependency dump, polished buffer overflow, path traversal, sophisticated race condition).

The improvement was dramatic:

| Metric | Before (29 reports) | After (16 reports) |
|--------|---------------------|-------------------|
| Cohen's d effect size | 0.06 (negligible) | **1.63 (large)** |
| AUC-ROC | ~0.52 (random) | **0.781 (fair)** |
| Best accuracy | 58.6% | **87.5%** |
| Score gap between groups | 0.5 points | **3.6 points** |

Cohen's d went from "statistically indistinguishable" to "large effect size." The system could now meaningfully tell slop from legitimate reports. At an optimal threshold of 36, it correctly classified 14 of 16 reports.

The individual axes showed strong discrimination:

- Linguistic axis: mean 21.8 for slop vs 0.4 for legit (gap: 21.4)
- Factual axis: mean 19.6 for slop vs 1.9 for legit (gap: 17.8)
- Template axis: mean 37.5 for slop vs 0.0 for legit (gap: 37.5)

But two problems remained. First, the LLM scoring axis was still broken — returning null on every single report across 45+ tests. That means the system was running on less than two-thirds of its intended detection capability. Second, the score range was severely compressed: all scores fell within a 9-point band (34-43) because the fusion formula's midpoint anchor was pulling everything toward the center.

---

## Sprint 2: The Scoring Overhaul

### Killing the Midpoint Anchor

The original fusion formula was `final = raw * confidence + 50 * (1 - confidence)`. When confidence is 0.30 (which it was for most reports), this maps everything to the 35-43 range regardless of how strong the underlying signals are. A template detector screaming at 100 and linguistic markers at 47 still only produced a slop score of 41.

The problem: 50 as a midpoint assumes the base rate of slop is 50%. It's not. Most vulnerability reports, even in the current environment, are not AI slop. The prior should be low, and evidence should push it up.

We replaced the formula with an additive evidence model using Noisy-OR probability combination:

```
Base prior: 15 (assumption: most reports are legit)
Each axis converts to a probability signal (0.0 to 1.0)
Combined probability: 1 - product(1 - p_i) for all firing signals
Final score: 15 + combined_probability * 80
```

This means: if the linguistic axis fires alone at 47/100, the score goes to roughly 53. If linguistic fires at 47 AND the template detector fires at 100, they compound to approximately 82. Multiple independent signals reinforce each other instead of averaging out. And when nothing fires, the score stays at 15 — a clean baseline that actually looks clean.

The score range expanded from 5-95 instead of 34-43. PSIRT teams can now set a meaningful threshold.

### Negative Evidence: The Human Indicators

The system could only push scores UP. Legit reports just defaulted to the baseline. But reports with strong human signals should actively score below the baseline — a report written by a real researcher looks different from "no evidence either way."

We built a human indicator detection system:

- **Contractions present** (weight -5): Real researchers write "don't" and "isn't." AI models default to "do not" and "is not."
- **Terse, direct style** (weight -4): Short sentences, no filler. Average sentence length under 15 words with more than 3 sentences.
- **Named researcher credited** (weight -3): "Reported by Sarah Chen" vs. the AI default of "Security Researcher."
- **Real commit/PR references** (weight -6): A link to a specific GitHub commit like `curl/curl@a1b2c3d` means someone actually looked at the code.
- **Specific fix version** (weight -3): "Fixed in v2.4.7" means the reporter tracked the patch.
- **Informal language** (weight -4): Exclamation marks, sentence fragments, first-person observations. Real researchers write casually.
- **Advisory format without AI pleasantries** (weight -3): Structured advisory format (CVE ID, affected versions, description, fix) without "Dear Security Team" or "I hope this helps."

These negative weights pull the score down below the 15 baseline, creating maximum separation between "definitely human" (score 5-12) and "definitely slop" (score 75-95).

### Sensitivity Presets: Tuning Without Polluting

Different PSIRT teams have different tolerance levels. A small open-source project drowning in slop might want aggressive filtering. A large corporation with legal obligations to respond to every report might want lenient filtering with nothing auto-dismissed.

We added sensitivity presets that work as a post-processing overlay on top of the canonical score:

- **Strict**: Linguistic and factual weights multiplied by 1.5, human indicator weights reduced to 0.7. Catches more slop, but with higher false positive risk.
- **Balanced**: All weights at 1.0. The default.
- **Lenient**: Linguistic and factual weights reduced to 0.7, human indicators boosted to 1.5. Fewer false positives, but some slop gets through.

Critically, the sensitivity adjustment does not change the stored canonical score. When a user rechecks the same report with different sensitivity settings, we recognize the report by its content hash and apply the new sensitivity as an overlay. The stored score, the statistical data, and the report count all remain clean. No data pollution from repeated checks with different settings.

### Content-Hash Dedup

Every report gets a SHA-256 hash of its normalized text (trimmed, whitespace-collapsed, lowercased). The first time we see a hash, we run the full scoring pipeline and store the result. Subsequent checks against the same hash return the cached canonical score (adjusted by the current sensitivity setting) and increment a check counter — but don't re-run the pipeline, don't create a new database record, and don't affect aggregate statistics.

This means a PSIRT team can re-check the same report 50 times with different sensitivity settings and it counts as one report in the stats. The data stays clean.

### Recalibrated Tiers

With the expanded score range, we redefined the tier labels:

| Score | Tier | Meaning |
|-------|------|---------|
| 0-20 | Clean | Strong human signals, no slop indicators |
| 21-35 | Likely Human | Minor flags but probably legitimate |
| 36-55 | Questionable | Mixed signals, manual review needed |
| 56-75 | Likely Slop | Multiple AI indicators firing |
| 76-100 | Slop | Near-certain AI generated |

---

## Sprint 3: Active Content Validation and Adversarial Resistance

### The Fundamental Problem with Style Detection

Everything in Sprints 1 and 2 detects slop based on how the report is *written*. This works against lazy slop generators, but it has a fundamental shelf life: if a reporter can see the detection heuristics (or just reads this blog post), they tell their AI to avoid the triggers. "Don't use formal language. Don't start with Dear Security Team. Use contractions. Keep sentences short." One prompt tweak bypasses months of detection engineering.

Sprint 3 built the layer that can't be bypassed without doing real work: **factual verification**. If VulnRap checks whether the function names, file paths, CVE IDs, and code references in your report actually exist in the claimed project, you can't fake that without finding real functions and real files — at which point you're doing actual security research, and the report isn't slop anymore.

### Project Detection

When a report references a public open-source project, VulnRap identifies it. We extract GitHub/GitLab repository URLs, npm/PyPI package references with version numbers, and match against a lookup table of known projects (curl, OpenSSL, nginx, Node.js, Django, Flask, Express, WordPress, and more — extensible by the community).

### Function and File Verification via GitHub API

If we can identify the repository, we check the claims:

When a report says "the vulnerability is in `curl_parse_header_secure()` in `lib/header_parser.c`," VulnRap queries the GitHub code search API for that function name in the claimed repository and checks the contents API for that file path. If the function doesn't exist and the file doesn't exist, those are strong slop signals (weight +20 and +18 respectively). If they do exist, those are strong human signals (weight -8 and -6) — somebody actually looked at the code.

We limit to 5 API checks per report (3 functions, 2 files) to stay within GitHub rate limits, filter out common stdlib functions (printf, malloc, strlen — nobody gets credit for "discovering" those), and add 200ms delays between calls.

### CVE Cross-Referencing with Plagiarism Detection

Checking "does this CVE exist in NVD" is table stakes. We go further: is the report just rewording the NVD description?

For each referenced CVE, VulnRap fetches the NVD entry and computes a phrase-overlap similarity score. We extract 5-word sequences from the NVD description and check how many appear in the report. If more than 30% of the NVD phrasing shows up in the report, it's flagged as potential copy-paste plagiarism (weight +15). This catches the extremely common pattern where an AI reads the CVE description and paraphrases it as a "discovery."

A fabricated CVE that doesn't exist in NVD at all gets weight +20 — that's a hallucination.

### PoC Plausibility Checking

When a report includes a "proof of concept," we assess whether it's a real test or a template:

- **Placeholder domains**: Commands using `target.com`, `example.com`, `vulnerable-server.com`, or `attacker.com` instead of actual endpoints (weight +12). A real researcher tests against a real target.
- **Textbook payloads combined with placeholders**: `alert(1)`, `' OR '1'='1'`, `{{7*7}}`, `../../etc/passwd` are legitimate test payloads, but when combined with placeholder domains, the combination is almost certainly a template, not a real test (weight +15).
- **Fabricated HTTP responses**: Reports sometimes include "captured" HTTP responses showing tokens or admin access. We check whether those responses include realistic server headers (Date, Server, Content-Length with plausible values). Missing realistic headers suggests the response was fabricated (weight +10).

### The Verification Panel

Instead of just returning a score, VulnRap now returns a verification checklist showing the triager exactly what was checked:

```
Verification Results:
  Function exists: curl_parse_header_secure()    ❌ NOT FOUND
  Function exists: curl_easy_perform()            ✅ Verified (lib/easy.c)
  File exists: src/http/multipart.c               ❌ NOT FOUND
  CVE exists: CVE-2026-31790                      ✅ Verified in NVD
  NVD plagiarism: CVE-2026-31790                  ⚠️ 42% phrase match
  PoC plausibility: curl command                  ⚠️ Placeholder domain
```

A triager can scan this in five seconds and know whether to dig deeper or close the ticket. That verification panel is what makes VulnRap indispensable — it's not just a number, it's evidence.

### The Layered Defense Model

We designed the adversarial resistance around a principle: every bypass costs the attacker something. The defenses are layered so that bypassing one requires doing progressively more real work:

**Layer 1 — Style Detection.** Cost to bypass: modify the LLM prompt (about 5 minutes). Shelf life: 6-12 months. This catches about 80% of slop today because most generators are lazy.

**Layer 2 — Factual Verification.** Cost to bypass: reference real code, real CVEs, real file paths. Shelf life: years. You can't fake a GitHub code search result.

**Layer 3 — Claim Depth Analysis.** Cost to bypass: produce original analysis, not just NVD rewording. Shelf life: years. Requires genuine understanding of the vulnerability.

**Layer 4 — Behavioral Signals.** Cost to bypass: change submission patterns, build submission history. Shelf life: indefinite. Game-theoretically stable.

**Layer 5 — LLM Semantic Judgment.** Cost to bypass: unpredictable. Evolves as models improve.

The key insight: if someone bypasses all five layers, they've done actual security research. At that point, the report probably isn't slop — it's a legitimate (if AI-assisted) finding. And that's fine. VulnRap isn't anti-AI. It's anti-slop.

### Temporal Signals

If a CVE is published at 14:00 UTC and VulnRap receives a "detailed analysis" at 14:07 UTC, that's 7 minutes. Nobody discovers, analyzes, and writes up a vulnerability in 7 minutes. Reports submitted within 2 hours of CVE publication get flagged (weight +12). Within 24 hours gets a lighter flag (weight +5).

### Cross-Report Template Detection (Mad-Libs Fingerprinting)

Slop generators often use the same template and swap out the project name, CVE ID, and URLs. We detect this by normalizing the report — replacing all CVE IDs with `CVE-XXXX-XXXXX`, all URLs with `URL_PLACEHOLDER`, all proper nouns and version numbers with placeholders — and hashing the skeleton. If two reports submitted to different programs produce the same skeleton hash, they're the same template with different names swapped in (weight +25).

We also hash individual sections (description, impact, PoC, remediation) to catch partial template reuse, where the attacker customizes some sections but copy-pastes others.

### Triage Recommendations

Based on the combined score and verification results, VulnRap now recommends a specific action:

- **AUTO_CLOSE**: Score >=75, confidence >=0.7. High-confidence slop with multiple corroborating signals.
- **MANUAL_REVIEW**: Score 55-75. Mixed signals, not conclusive.
- **CHALLENGE_REPORTER**: Multiple claimed code references don't exist. Send specific questions back.
- **PRIORITIZE**: Score <=25, 2+ verified references. Likely legitimate, proceed with triage.
- **STANDARD_TRIAGE**: No strong signals either way.

### Challenge Question Generator

For questionable reports, VulnRap generates specific questions the triager can send back. Real researchers answer these easily; slop generators can't:

- "We could not locate `curl_parse_header_secure()` in the curl repository. Can you provide the exact file path, branch, and commit hash?"
- "Your description closely matches the NVD advisory text. Can you describe the specific steps you took to discover and verify this issue?"
- "Your proof of concept references placeholder domains. Can you provide output from running the PoC against the actual affected software?"
- "You've rated this as Critical. Can you provide evidence of impact beyond the initial vulnerability class?"

These challenge questions serve double duty: they verify suspicious reports AND they give the triager pre-written, professional responses they can send without spending 30 minutes drafting their own.

---

## Sprint 4: The AI Triage Assistant

### Beyond "Is This Slop?"

Detecting slop is necessary but not sufficient. The real danger for PSIRT teams isn't just wasting time on fake reports — it's accidentally dismissing a real vulnerability because it's buried in AI spam, or because a legitimate but poorly written report triggers suspicion.

Sprint 4 added an AI-generated triage report to every submission. The concept: for every report VulnRap analyzes, generate a complete triage guide that helps the security team actually do their job faster regardless of whether the report is slop or not.

### The Combined LLM Triage Analysis

We expanded the LLM analysis prompt to generate both slop assessment AND triage guidance in a single call. Instead of just "is this AI-generated?", the LLM now produces:

**Slop Assessment**: Five-dimensional scoring (specificity, originality, voice consistency, coherence, hallucination probability) plus reasoning and red flags.

**Triage Guide**: Specific reproduction steps, environment requirements (OS, software version, configuration, prerequisites, hardware notes), expected behavior if the vulnerability is real, and testing tips specific to the vulnerability type.

**Gap Analysis**: What's missing from the report, what scenarios weren't tested, and what scope questions remain unanswered.

**Reporter Feedback**: Strengths, improvements sorted by priority, a clarity score, and an actionability assessment.

All of this comes from a single LLM call at approximately $0.005 per report. At 100 reports per day, that's $0.50 — negligible. The triage guide alone saves a triager 15-30 minutes per report.

### Heuristic Reproduction Templates

The LLM produces initial reproduction steps, but we also built structured reproduction templates for eight common vulnerability classes as both a fallback (when LLM is unavailable) and an enrichment layer (LLM steps + heuristic environment notes).

Each template covers XSS, SQL injection, SSRF, deserialization, buffer overflow, path traversal, authentication bypass, and race conditions. Every template includes detection regex, step generation functions that extract version and endpoint information from the report text, and environment-specific notes that are hard to generate from scratch.

For example, the buffer overflow template tells the triager: "Compile with AddressSanitizer: `CFLAGS='-fsanitize=address' ./configure && make`. Run the PoC. Check ASan output for crash location. Compare with the report's claims. Also run Valgrind as a second opinion." And the environment notes warn: "Buffer overflows behave differently on 32-bit vs 64-bit. ASLR and stack canaries affect exploitability but not existence. If the report claims RCE from a heap overflow, that requires heap grooming which is highly environment-specific."

That kind of specific, practical guidance is what turns a 3-hour triage session into a 30-minute one.

### The "Don't Miss" Analysis

This is the feature that prevents the worst outcome: throwing away a real bug.

Even when the slop score is high, VulnRap runs a "what could go wrong if we dismiss this" check:

- **Vulnerability class is real**: "Even if this report is AI-generated, XSS vulnerabilities in this type of application are common. Consider a quick manual check of the referenced endpoint before closing."
- **Real CVE referenced**: "This report references CVE-2026-XXXXX. Even if the report itself is AI-generated, verify whether your deployment is affected independently."
- **Specific source file named**: "A specific source file is named. Even poorly written reports sometimes identify real attack surface. A 30-second grep of the codebase may be worthwhile."
- **Ambiguous score**: "This report scored in the ambiguous range. It may be a real finding by someone using AI to help write the report — increasingly common — rather than pure AI slop. Consider evaluating the technical claims on their merits."

That last warning acknowledges a reality that's becoming more important every month: legitimate researchers are using AI to help draft and format their reports. A report that "sounds like AI" might contain a genuine vulnerability discovered by a human who used ChatGPT to articulate it. Style signals matter less; factual verification matters more.

### Gap Analysis Engine

VulnRap systematically identifies what the report doesn't address, generating recommendations for both the triager and the reporter:

- **Version specificity**: No version = "Cannot determine if your deployment is affected." Single version = "Check adjacent versions."
- **Environment details**: No OS or runtime mentioned = "Some vulnerabilities are OS-specific or behave differently in containers vs bare metal."
- **Authentication context**: Unclear whether exploitation requires auth = "Test both authenticated and unauthenticated."
- **Impact demonstration**: Claims critical severity without demonstrating impact = "Actual exploitability may be lower than claimed."
- **PoC quality**: Claims PoC but no executable code = "Ask for a self-contained reproduction script."
- **Network position**: Network vulnerability without specifying required position = "Internet-facing, local network, or localhost only significantly affects severity."
- **Configuration requirements**: No mention of default vs custom config = "Test with default settings first."

Each gap has two messages: one for the triager (what to test) and one for the reporter (how to improve). This dual output means the same analysis helps triage the current report AND raises the quality of future submissions.

### Reporter Feedback

For every report, VulnRap generates constructive feedback that can be sent back to the reporter:

- Always finds strengths first (verified code references, detailed root cause, clear attack vectors)
- Lists improvements sorted by priority (critical, important, minor)
- For high-slop-score reports, includes specific warnings: "Your report contains phrases commonly associated with AI-generated content. If you used AI to help draft this, editing to include more of your own observations will help it be taken seriously."
- Acknowledges AI-assisted writing: "Removing formulaic openers and closers will help your report's credibility."

The feedback is designed to be professional and constructive — not accusatory. The goal is to raise report quality across the ecosystem over time.

### UI Integration

The triage report renders as a tabbed panel (Reproduce, Gaps, Don't Miss, Reporter Feedback) with a "Copy for Ticket" button that generates formatted markdown suitable for pasting into Jira, ServiceNow, or GitHub Issues. One click gives the triager a complete triage summary they can attach to the ticket.

The results page also includes several visualization features designed for at-a-glance triage:

- **Confidence Gauge**: A semicircular gauge showing how certain the analysis is, color-coded from orange (low) through yellow (medium) to green (high). This tells triagers whether to trust the score or treat it as a rough estimate.
- **LLM Radar Chart**: When LLM analysis is available, the five semantic dimensions (Specificity, Originality, Voice, Coherence, Hallucination) render as a radar/spider chart alongside the traditional bar breakdown. The shape of the polygon tells an immediate visual story — a legitimate report produces a small, even polygon; slop produces a large, spiky one.
- **Evidence-Highlighted Report Text**: The redacted report text is displayed with inline citations — matched AI phrases are highlighted in red, human signals in green. Hovering over any highlight shows the evidence type and weight. This lets a triager scan the original text and see exactly what triggered each signal, instead of cross-referencing between a list of evidence items and the report.
- **Analysis Progress Stepper**: During submission, a multi-step stepper shows the analysis pipeline progressing through Upload → Redact → Linguistic → Factual → Template → LLM → Triage, replacing the generic spinner. This builds confidence that something meaningful is happening and gives a sense of how much longer to wait.

---

## What We Learned from the OpenSSF Community

We've been following the OpenSSF Vulnerability Disclosures Working Group's discussions on AI slop (GitHub issues #178 and #179), the Google Doc surveying existing practices, and the ongoing conversation among maintainers of projects like curl, Log4j, Node.js, and CPython. Here's what resonated and what we've incorporated:

### Validated by the Community

**"Discovery without validation is slop."** The OpenSSF consensus is that requiring proof-of-work — a functional PoC and demonstrated understanding — is the most effective defense. VulnRap's PoC plausibility checking and factual verification are implementations of this principle. We can't force reporters to include a PoC (that's the intake form's job), but we can detect when one is missing, when it's a template, or when it references placeholder domains instead of real targets.

**"Technically true but not a vulnerability."** The Log4j team's observation that many reports describe real behavior that doesn't meet their threat model is a pattern we've seen across projects. VulnRap's gap analysis and scope questions help triagers identify these faster, and the reporter feedback explains why "the library uses MD5 for checksums" isn't necessarily a vulnerability in every context.

**"The LLM itself concluded no vulnerability existed, but the user posted the report anyway."** This was a specific case documented by the Log4j team. We added self-contradiction detection to our analysis — if the report's own reasoning undermines its severity claim, that's a signal.

**"3-4 people, 3 hours each, per report."** This cost estimate from both curl and Log4j validates VulnRap's entire product thesis. If we can cut triage time from 3 hours to 30 minutes through pre-generated reproduction steps, verification results, and gap analysis, the ROI is immediate and massive.

**"Refusing reports does not make potential findings go away."** CRob's note in the OpenSSF discussion perfectly captures why VulnRap includes the "Don't Miss" feature. The goal is not to block reports — it's to prioritize them so real vulnerabilities don't get lost in the noise.

### What We Evaluated and Decided Against

**Automated PoC sandbox execution (Firecracker/GVisor):** Running untrusted code from vulnerability reports in an isolated sandbox is an interesting long-term vision, but it's a massive infrastructure project with its own security surface. It's on our roadmap as a product-level feature, not a sprint.

**Cyber Reasoning Systems (CRS) integration:** Using systems like the OSS-CRS framework from DARPA's AIxCC to validate reports by generating patches sounds futuristic, but these tools are research-grade, not production-ready. And scoring reports on whether they're machine-processable would accidentally reward well-structured AI slop.

**The "slop deposit" fee model:** Requiring a refundable fee for report submissions was suggested in the community and creates a real barrier to low-effort slop. But it also creates a barrier for legitimate researchers, especially those in developing countries. It's a platform economic decision, not a detection problem, and not VulnRap's domain.

---

## The Hard Cases: What Still Beats Us

We believe in being transparent about where the system's limits are. Two reports in our 16-report retest evaded detection:

**The professional SSRF report (S03)**: Scored 34, same as legitimate reports. It avoided AI catchphrases, used a professional tone, and was structurally well-organized. The only detection signal was `target.com` in a curl command, which wasn't weighted heavily enough to overcome the baseline.

**The sophisticated race condition (S08)**: Scored 34. Well-written slop with no AI fingerprints, realistic technical depth, and plausible-sounding analysis. It used `example.com` in a curl command (detected as one factual signal) but the linguistic and template axes found nothing.

Both of these require either the LLM analysis axis (still being debugged) or the factual verification layer (Sprint 3) to catch. When someone puts effort into making slop look real — uses real function names, avoids AI phrases, writes in a natural voice — the style detection layers can't catch it. That's by design. Style detection has a shelf life. Factual verification doesn't.

If someone writes a polished report about a race condition in `curl_easy_perform()` and that function actually exists and the described behavior is plausible — well, either they did real research or they got lucky. Either way, it deserves human review.

---

## Where We're Going: Sprint 5

Based on our retest results, the OpenSSF community discussions, and real-world feedback from PSIRT teams, the next sprint focuses on four areas:

**Reporter Reputation Scoring.** Track submission history by reporter identifier. If the same email or username submits three consecutive reports that all score above 70, the fourth report gets a reputation penalty. But reputation needs to be harder to game than creating a new HackerOne account — so we're looking at fingerprinting submission patterns (writing style, template structure, timing clusters) rather than relying on account IDs.

**Internal Consistency Checking.** AI reports often contain contradictions between their structured claims. A report might claim CVSS 9.8 (network vector, low complexity, no authentication required) while describing an attack that requires local access and admin privileges. We're building cross-validation between the CVSS vector string, the CWE classification, the described impact, the stated prerequisites, and the report narrative. Consistency across all of these is hard for an AI to maintain.

**Self-Contradiction Detection.** Extending the LLM analysis to explicitly flag reports where the reasoning undermines the conclusion. "This could potentially lead to remote code execution, although the vulnerable function is not reachable from any external input" — that's the report arguing against itself.

**Configurable Project Threat Model.** A lightweight feature allowing PSIRT teams to define out-of-scope vulnerability classes for their project. If a team explicitly excludes availability issues (DoS) from their scope, VulnRap flags "technically true, not a vulnerability here" reports that describe DDoS against an intentionally-public static website. This directly addresses the pattern Log4j described.

---

## By the Numbers

Here's where VulnRap stands today, measuring from our initial baseline to the most recent retesting:

| Metric | Baseline | Current | Improvement |
|--------|----------|---------|-------------|
| Cohen's d (effect size) | 0.06 | 1.63 | 27x increase |
| AUC-ROC | 0.52 | 0.781 | From random to fair |
| Best accuracy | 58.6% | 87.5% | +28.9 percentage points |
| Mean score gap | 0.5 pts | 3.6 pts | 7x wider |
| False positive rate (legit flagged as slop) | 47% | 12.5% | -34.5 percentage points |
| Detection axes | 1 (quality) | 4 (linguistic, factual, template, LLM) | 4x coverage |

And these numbers are WITHOUT the LLM axis active. When we get that debugged, we expect the AUC to push above 0.85 and accuracy above 90%.

---

## The Philosophy

VulnRap's job is not to be a wall. It's not a CAPTCHA. It's not designed to punish reporters or prevent submissions. It's designed to be the triager's first pass — the 30-second scan that tells a security team "this needs your attention" vs "this can wait" vs "send these challenge questions back."

The world where AI-assisted security research exists alongside AI-generated slop is the world we live in now. A good triaging tool needs to handle both: catch the slop, surface the real findings, and — critically — never be so aggressive that a genuine vulnerability gets lost in the filter.

Every feature we've built comes back to that principle. The verification panel shows evidence, not just a number. The "Don't Miss" warnings prevent false dismissals. The reporter feedback raises quality over time. The challenge questions give triagers professional responses without burning hours. The triage guide turns a 3-hour investigation into a 30-minute one.

Daniel Stenberg wrote that the slop problem is "death by a thousand cuts." We're building the armor. It's not perfect yet — we're honest about what still beats us — but it's getting meaningfully better with every sprint.

If you're a PSIRT team, a bug bounty program, or an open-source maintainer dealing with this problem, try VulnRap. Submit a report at vulnrap.com and see how it scores. The check endpoint is free, read-only, and doesn't store your data unless you want it to. And if you find a report that beats our detection, tell us — that's how this gets better.

---

*VulnRap is free and open. The API is at `POST /api/reports/check`. The source is on our GitHub. If you want to talk about PSIRT tooling, AI slop defense, or the future of vulnerability disclosure, reach out.*
