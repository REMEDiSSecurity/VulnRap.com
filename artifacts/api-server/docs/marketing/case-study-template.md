# Case Study — <Customer or Scenario Name>

**Published:** YYYY-MM-DD
**Audience:** <Who this case study is aimed at — PSIRT leads, bug-bounty platform ops, AppSec managers, etc.>
**Reading time:** ~5 minutes

> **Note for authors:** This is a reusable template. Keep section headings
> as-is so the case studies render consistently. Replace every `<...>`
> placeholder. If a section genuinely doesn't apply, write "N/A — <reason>"
> rather than deleting the heading. If the numbers in the case study are
> illustrative (synthetic / composite / anonymized), say so explicitly at
> the top of the Results section. Never imply a real customer endorsement
> that hasn't been confirmed in writing.

---

## Background

<!--
Two or three short paragraphs. Who is the team? What do they do? How big
is their report intake? What tools do they already use (HackerOne,
Bugcrowd, Intigriti, custom intake form, email)? Set the scene without
naming the customer unless you have written permission.

Aim for: a reader who has never heard of this team should be able to
picture their workflow within 30 seconds.
-->

<Background paragraphs go here.>

---

## Challenge

<!--
What was hurting before VulnRap? Be concrete. Use numbers if you have
them — backlog size, hours per report, % duplicates, % low-validity, time
to first response. If the numbers are illustrative, label them as such
in the Results section, not here.

Good challenge statements name a specific failure mode:
- "Triagers were spending ~40% of their week on reports that turned out
   to be theoretical / fabricated."
- "Cross-platform duplicates weren't being caught until a second analyst
   noticed the same PoC two weeks later."

Bad challenge statements are vague:
- "They had too many reports." (How many? Compared to what?)
- "Quality was bad." (Bad how? Measured how?)
-->

<Challenge paragraphs go here.>

---

## Approach

<!--
What did the team actually do with VulnRap? Walk through the integration
in plain language. Mention specific endpoints, thresholds, and where
VulnRap sits in their pipeline.

Useful structure:
1. Where VulnRap was inserted (intake form? Jira webhook? manual paste?).
2. What thresholds were chosen and why (e.g. "auto-deprioritize > 70,
   manual review 30–70, fast-track < 30").
3. What stayed unchanged (humans still make the final call, etc.).
-->

<Approach paragraphs go here.>

---

## Results

<!--
**If the numbers are illustrative, say so on the very first line of this
section.** Example:

> The numbers below are illustrative — composited from internal testing
> and conversations with PSIRT teams, not from a single named customer.

Then give 3–6 concrete metrics. Prefer before/after pairs. Use units.
Round honestly — don't write "47.3%" if you mean "around half".

Suggested table:

| Metric | Before | After | Change |
|---|---|---|---|
| Avg. triage hours / week | <X> | <Y> | <Z%> |
| Reports auto-deprioritized | 0 | <N> / week | new |
| Duplicate detection lag | <X days> | <Y hours> | <Z%> |
| Analyst-flagged false positives | <X> | <Y> | <Z%> |
-->

<Results table and prose go here.>

---

## Quote

<!--
One short pull-quote (1–3 sentences) from the team. Attributed if you
have permission, otherwise attributed by role only ("PSIRT Lead, Fortune
500 SaaS company"). Never fabricate a quote — if you don't have one,
delete this section entirely rather than inventing words.
-->

> "<Pull quote here.>"
>
> — <Name or role>, <Company or "anonymized at the team's request">

---

## About the team

<!--
2–4 sentences. Industry, rough size, and the shape of their security
program. Helps readers self-identify ("we look like that, this might
work for us"). Link to the customer's site if and only if they've
approved the case study publicly.
-->

<About paragraph goes here.>

---

## Want to try this yourself?

- Read the [API docs](/developers) to see the endpoints used above.
- Run a single report through the [Check page](/) to get a feel for the scoring.
- Email <remedisllc@gmail.com> if you want help wiring VulnRap into your intake pipeline.
