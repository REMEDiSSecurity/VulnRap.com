# Email Signature + Outreach Templates

> Standardized signature and three cold-outreach templates for VulnRap / REMEDiS Security business development.

---

## HTML Email Signature

Drop this snippet directly into Gmail, Outlook, or any HTML-aware mail client. The inline `style` attributes survive the most aggressive client sanitizers.

```html
<table cellpadding="0" cellspacing="0" border="0" style="font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.4;">
  <tr>
    <td style="padding-right: 16px; vertical-align: top;">
      <a href="https://vulnrap.com" style="text-decoration: none;">
        <img src="https://vulnrap.com/email-logo.png"
             alt="VulnRap"
             width="56" height="56"
             style="display: block; border: 0; border-radius: 8px;" />
      </a>
    </td>
    <td style="vertical-align: top; border-left: 2px solid #6366f1; padding-left: 16px;">
      <div style="font-weight: 600; font-size: 15px; color: #111827;">[FULL NAME]</div>
      <div style="color: #4b5563; margin-top: 2px;">[ROLE] · REMEDiS Security</div>
      <div style="margin-top: 8px; color: #4b5563;">
        <em>Open-methodology scoring for AI-generated vulnerability reports.</em>
      </div>
      <div style="margin-top: 8px;">
        <a href="https://vulnrap.com" style="color: #6366f1; text-decoration: none; font-weight: 500;">vulnrap.com</a>
        &nbsp;·&nbsp;
        <a href="mailto:[EMAIL]" style="color: #6366f1; text-decoration: none;">[EMAIL]</a>
        &nbsp;·&nbsp;
        <a href="https://vulnrap.com/test-yourself" style="color: #6366f1; text-decoration: none;">Try the scorer →</a>
      </div>
    </td>
  </tr>
</table>
```

### Plain-text fallback

```
[FULL NAME] · [ROLE]
REMEDiS Security · vulnrap.com
Open-methodology scoring for AI-generated vulnerability reports.
Try the scorer: https://vulnrap.com/test-yourself
```

### Variant: short signature (replies, internal threads)

```
— [FIRST NAME] · VulnRap (REMEDiS Security)
   vulnrap.com · [EMAIL]
```

---

## Cold Outreach Templates

Each template uses bracketed `[PLACEHOLDERS]`. Always personalize at least one sentence per email — generic blasts hurt deliverability and conversion.

### Template 1: Intro to a PSIRT Lead

**Subject lines (A/B options):**
- `Drowning in AI-written advisories? We built a fix.`
- `[COMPANY]'s PSIRT + an open scorer for AI report slop`
- `15 min on quantifying the AI-report flood at [COMPANY]?`

**Body:**

```
Hi [FIRST NAME],

I lead [ROLE] at REMEDiS Security. We built VulnRap, an
open-methodology scoring engine that flags AI-generated and
low-substance vulnerability reports before they consume triage hours.

Most PSIRTs we talk to are seeing a [N]x jump in AI-written
submissions over the past year. Keyword filters miss them.
Manual review does not scale. Our pipeline scores each report
across five engines (linguistic entropy, technical substance,
CWE coherence, adversarial template fingerprinting, reputation
signals) and returns a single 0–100 score with the verbatim
phrases and weights that drove the verdict — fully auditable, so
your reviewers can override anything.

Two things I would love to learn from you:
  1. What does your current AI-report intake volume look like?
  2. What would a 30 % reduction in low-substance triage time
     unlock for the rest of the program?

Happy to share holdout accuracy data and walk through a few
real examples. 20 minutes next week?

Best,
[FIRST NAME]

PS — You can drop a sample report into vulnrap.com/test-yourself
right now to see exactly what reviewers would see.
```

### Template 2: Intro to a Bug Bounty Platform

**Subject lines (A/B options):**
- `Slop-detection layer for [PLATFORM] programs?`
- `Open-methodology scoring for AI-generated reports — partnership idea`
- `[PLATFORM] + VulnRap: a quick conversation`

**Body:**

```
Hi [FIRST NAME],

I'm [YOUR NAME] from REMEDiS Security. We run VulnRap, the
open-methodology scoring service for AI-generated vulnerability
reports. We are already integrated with several programs via
direct API and our GitHub Action / GitLab CI component.

I'm reaching out because [PLATFORM] sits at the choke point
where this problem matters most: every program on your platform
is asking the same question about AI report slop, and right now
each one is solving it independently (or not at all).

A few directions we could explore together:
  - Native triager-side score badges in the [PLATFORM] UI
  - Optional pre-submission scoring as a researcher feedback loop
  - Aggregate slop-trend data published on your platform stats

Our methodology is fully public and our scores are auditable, so
nothing is hidden behind a black box. We are happy to start with
a no-commitment data-sharing pilot on one program to prove the
value before any deeper integration discussion.

Could we find 30 minutes in the next two weeks?

Best,
[FIRST NAME]
[EMAIL] · vulnrap.com
```

### Template 3: Intro to a CISO

**Subject lines (A/B options):**
- `[COMPANY]'s vuln intake is being optimized for AI-generated reports`
- `A budget-line item your security team is about to ask for`
- `Quick note on AI-generated vulnerability reports at [COMPANY]`

**Body:**

```
[FIRST NAME],

Quick note from a peer in the security tooling space.

Across the programs we work with, AI-generated vulnerability
reports now make up [N] % of intake volume — and the share is
climbing roughly [N] points per quarter. The downstream cost
shows up as triage hours, not as a line item, so it tends to
stay invisible until your AppSec lead raises it.

I lead [ROLE] at REMEDiS Security. We built VulnRap, an
open-methodology scoring engine that gives your team a single
auditable 0–100 score per report, plus the specific signals
that drove it. It plugs into your existing intake pipeline via
API or CI in under a day, and every verdict is fully
explainable to a researcher who challenges it.

Three things I think are worth your attention:
  1. The volume curve is steeper than most leadership decks show.
  2. The reputational risk of mis-rejecting a legitimate report
     is real, which is why auditability is non-negotiable.
  3. Open methodology beats black-box detection for trust and
     adversarial robustness.

If any of that resonates, I'd value 20 minutes to share what
we are seeing across the broader market — no pitch deck, just
data. Worth a brief call?

Respectfully,
[YOUR NAME]
[ROLE], REMEDiS Security
[EMAIL] · vulnrap.com
```

---

## Follow-up Cadence

The single biggest determinant of cold-outreach reply rate is the follow-up sequence. Three short, value-adding touches outperform one long pitch.

| # | Days after initial | Channel | Purpose | Length |
|---|--------------------|---------|---------|--------|
| 1 | Day 0 | Email | Initial outreach (templates above) | ≤ 200 words |
| 2 | Day 4 | Email reply (in same thread) | One concrete data point or example link, no re-pitch | ≤ 80 words |
| 3 | Day 11 | Email reply (in same thread) | Soft permission close ("Should I follow up next quarter or close the loop?") | ≤ 50 words |
| 4 | Day 18 | LinkedIn connect (optional) | Connection request referencing the email thread, no message | — |
| 5 | Day 60 | New email thread | New subject line, new hook (e.g. published incident, new feature, public stat) | ≤ 150 words |

### Cadence rules

- Always reply to the existing thread for follow-ups 2 and 3 — never start a new subject line until step 5.
- Lead each follow-up with new information (a benchmark, a published incident, a customer quote) rather than restating the original ask.
- Stop the cadence immediately on any reply, including a "not now." Resume at step 5 only with a genuine new hook.
- Track outreach in a shared CRM or spreadsheet. Note the subject-line variant used so we can compare reply rates.
- Never send more than two emails in any 7-day window. Anything more aggressive damages domain reputation.

### Sample step-2 follow-up

```
Hi [FIRST NAME] —

Following up briefly. Since my last note, we published our
holdout accuracy numbers for Q1 (93.7 % across [N] thousand
submissions): [LINK].

Worth a quick look if AI-report intake is on your radar this
quarter. Happy to share the methodology details directly.

[FIRST NAME]
```

### Sample step-3 follow-up

```
[FIRST NAME] — closing the loop on this thread. Should I check
back in next quarter, or is this not a fit right now? Either
answer is genuinely fine.

— [FIRST NAME]
```

---

## Asset placeholders

The signature references `https://vulnrap.com/email-logo.png`. If that asset does not yet exist, fall back to the text-only short signature variant above until the logo is hosted at a stable URL with appropriate caching headers.
