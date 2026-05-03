# Case Study — PSIRT Cuts Triage Backlog with VulnRap Intake Screening

**Published:** 2026-05-02
**Audience:** PSIRT leads, AppSec managers, and bug-bounty program owners drowning in inbound report volume.
**Reading time:** ~5 minutes

> **Heads up — illustrative numbers.** This case study is a composite,
> built from internal testing against fixture corpora and conversations
> with PSIRT teams during VulnRap's design phase. It is **not** an
> endorsement from a single named customer, and the metrics below are
> directional rather than measured against one specific deployment.
> We're publishing it as a worked example of the _shape_ of the win
> teams can expect, not a guarantee of the exact percentages.

---

## Background

The team in this scenario runs the PSIRT function for a mid-size SaaS
company — roughly 800 engineers, a public vulnerability disclosure
program, and a paid bug-bounty program running on one of the major
platforms. Two senior triagers and one rotating on-call engineer handle
inbound reports. Volume is steady at around 60–90 reports per week
across the disclosure inbox and the bounty platform combined, with
occasional spikes around major release windows.

Before VulnRap, every inbound report got the same first-pass treatment:
a triager opened it, read the title and impact, skimmed the PoC, and
either escalated, asked for more info, or closed it as not-applicable /
duplicate / informational. That worked when volume was lower. By
late 2025, the team estimated that roughly 35–45% of analyst time was
going to reports that were eventually closed as low-validity — either
fabricated, theoretical, or a near-duplicate of something already in
the queue.

---

## Challenge

The pain wasn't any single category of bad report — it was the
_indistinguishability_ problem. A well-formatted report describing a
plausible-sounding attack reads almost identically whether it's a real
finding or a confidently-written hallucination. Triagers had no signal
to sort the queue by other than "first in, first out", which meant
genuine high-severity reports sometimes sat behind a stack of
fabricated CVE-name-dropping submissions for hours.

Specifically, the team called out three recurring failure modes:

1. **Cross-submission duplicates going undetected.** A bounty hunter
   would submit the same finding to the bounty platform and the
   disclosure inbox a few days apart, sometimes with the target hostname
   swapped. Different triagers picked them up and re-did the same work.
2. **"Spray and pray" template reports.** Reports with identical impact
   sections and PoC blocks, with only the target name changed, were
   landing from multiple unrelated reporter accounts.
3. **Plausible-but-fabricated reports** describing attacks against
   versions or endpoints that didn't exist in the product. These took
   the longest to disprove because they _read_ well.

---

## Approach

The team wired VulnRap into their intake at two points, both via the
public API — no data was stored on VulnRap's side beyond what the
existing `/api/reports/check` flow already records.

1. **Inbox webhook.** When a new report lands in the disclosure inbox
   (a custom intake form that posts to an internal queue), a worker
   `POST`s the body to `/api/reports/check` and tags the resulting
   ticket with the validity score and any duplicate matches before a
   human ever sees it.
2. **Bounty-platform poller.** A scheduled job pulls new submissions
   from the bounty platform's API every 15 minutes and runs the same
   check, attaching the VulnRap score and the verify URL as a private
   comment on the submission.

The triage rules were kept simple and intentionally conservative:

- **Score < 30** — fast-track to a triager. These are the reports most
  likely to be genuine findings.
- **Score 30–70** — normal queue, no change in behavior.
- **Score > 70** — move to a "batch review" lane. A triager works
  through these once a day in a single sitting rather than
  context-switching for each one.
- **Duplicate match ≥ 80%** — auto-comment with a link to the matched
  report and require triager confirmation before closing. Humans still
  make the final dedup call.

Critically, **no report was ever auto-closed by the integration.** The
team's policy is that a human always makes the final call on validity
and dedup. VulnRap only changes the order and grouping of work.

---

## Results

> The numbers below are illustrative — composited from internal testing
> against VulnRap's fixture corpora and conversations with similarly
> sized PSIRT teams, not from a single named customer.

| Metric                                                              | Before    | After (≈ 6 weeks in) | Change          |
| ------------------------------------------------------------------- | --------- | -------------------- | --------------- |
| Median time-to-first-response, high-validity reports                | ~14 hours | ~5 hours             | ~64% faster     |
| Analyst-hours / week spent on eventually-closed-as-invalid reports  | ~22 hours | ~12 hours            | ~45% reduction  |
| Cross-submission duplicates caught at intake                        | ~10%      | ~70%                 | ~7× more        |
| Reports auto-batched into "low-priority review" lane                | 0 / week  | ~25 / week           | new behavior    |
| Triager-reported "context-switch fatigue" (qualitative survey, 1–5) | 4.1       | 2.6                  | meaningful drop |

The biggest win wasn't the raw hour reduction — it was the change in
_what those hours felt like_. Triagers stopped opening every report
cold and started the day with a pre-sorted queue, which the team said
was the single most-cited improvement in their post-rollout retro.

The team also started using VulnRap's section-level hash comparison to
spot template-reuse across reporter accounts. Two coordinated
spray-and-pray campaigns were caught within the first month — both
would likely have eaten significant triage time before.

---

## Quote

> "We didn't change how many reports we get, and we didn't change who
> triages them. We just stopped reading the same fabricated report
> three different ways. That alone gave us our Fridays back."
>
> — PSIRT Lead, anonymized at the team's request

---

## About the team

Mid-size B2B SaaS company, ~800 engineers, public VDP plus a paid
bug-bounty program on a major platform. Security org of ~25 people,
with a dedicated 3-person PSIRT function handling all external
vulnerability intake. Industry: developer tooling. The team asked not
to be named publicly while they evaluate longer-term metrics.

---

## Want to try this yourself?

- Read the [API docs](/developers) to see `/api/reports/check` and the lookup endpoints used above.
- Run a single report through the [Check page](/) to get a feel for the scoring before wiring up an integration.
- Email <remedisllc@gmail.com> if you want help designing thresholds for your own intake pipeline.
