# Podcast Pitch Template — VulnRap

**Published:** 2026-05-02
**Audience:** Whoever on our side is doing outreach to security podcasts (Risky Business, Security Now, Darknet Diaries, Day[0], Security. Cryptography. Whatever., SANS Internet Stormcast, Hacking Humans, Click Here, Malicious Life, etc.).

---

## How to use this doc

This is a kit, not a script. Copy the variant that fits the show, swap in the host's name, the show's name, and one or two specifics that prove we actually listen to the show. Generic pitches get deleted. Pitches that reference a recent episode get read.

Three rules before you send anything:

1. **Listen to at least one recent episode.** Reference it by name in the first two sentences. Hosts can tell.
2. **Pitch a story, not a product.** "We built a thing" is a press release. "AI-generated vuln reports are drowning maintainers and we have data" is a story.
3. **Make it easy to say yes.** Include length variants, hooks, bio, and availability in the _first_ email. Do not make the host write back asking for a bio.

---

## Variant 1 — One-liner (subject line / DM / cold intro at a conference)

> VulnRap scores vulnerability reports for credibility before a human reads them — we have nine months of data on what AI-generated bug reports actually look like in the wild, and it's a better story than people think.

Use this as the email subject, the opener at a meetup, or the first line of a Signal/Twitter DM. Maximum 240 characters. Do not pad it.

---

## Variant 2 — Paragraph pitch (cold email body)

> Hi {{host_first_name}},
>
> Long-time listener — {{specific_recent_episode_reference}} was the one that made me finally write in. I run outreach for VulnRap, a free public scoring engine for vulnerability reports. Maintainers and PSIRTs paste in a report, we score it for credibility, and we explain _why_ — so the obvious AI-generated noise gets filtered without good researchers getting steamrolled.
>
> We've been live for about nine months and we now have enough signal data to say something concrete about what the "AI slop in bug bounty" wave actually looks like — which CWEs it clusters around, which platforms get hit hardest, and (the part nobody talks about) how often a real bug is hiding inside a slop-shaped report. I think there's a good 20–40 minute conversation in this for {{show_name}}, and I'd love to put our founder on with you.
>
> Pitch packet, hooks, bio, and availability below — happy to record any time in the next four weeks.
>
> — {{your_name}}

Keep this under 180 words. If it's longer, it's a memo, not a pitch.

---

## Variant 3 — Full pitch (for shows that ask for a one-pager, or for warm intros)

### Subject

`Pitch: the data behind the "AI slop bug bounty" wave — for {{show_name}}`

### Body

**Who we are.** VulnRap is a free, public scoring engine for vulnerability reports. A reporter (or a triager) pastes in a report; we return a credibility score, the per-signal breakdown that produced it, and a plain-English explanation. We are not a bug bounty platform, we don't take a cut of payouts, and we don't replace human triage — we just put a number and a rationale on something that used to be vibes.

**Why now.** The flood of AI-generated vulnerability reports hitting open-source maintainers, bug bounty programs, and corporate PSIRTs in 2025–2026 is the biggest shift in disclosure hygiene in a decade. Most coverage of it has been anecdotal ("daniel from curl is mad again"). We have nine months of scored reports across thousands of submissions, and the picture is more interesting than "AI bad."

**Why us, why this show.** Your audience is exactly the people getting hit by this — maintainers, AppSec leads, bounty triagers, independent researchers worried about being mistaken for bots. We're not selling them anything. We're handing them numbers.

**The pitch.** A 25–40 minute conversation with {{founder_name}}, our founder, walking through:

- What "slop" actually means when you measure it instead of complain about it
- The single signal that does the most work in our scoring (it's not the one people guess)
- The false-positive problem nobody wants to talk about: real bugs in slop-shaped reports
- What a "good" vuln report in 2026 looks like, concretely

We'll bring data, two or three anonymized real-world examples, and zero marketing slides.

**Format flexibility.** Solo interview, panel with a maintainer, or a "score this report live on the show" segment — we can do any of the three. The live-scoring format has gone over well at conferences.

**Logistics.** Remote-friendly, broadcast-quality mic and treated room, can record any weekday between 13:00 and 22:00 UTC. Two weeks of lead time preferred but we can move faster.

---

## Suggested talking points

Pick three or four for any given show — don't try to cover all of them in one episode.

- **The scoring rubric.** What signals VulnRap actually looks at, in plain English: reproducibility, version specificity, PoC presence, linguistic markers, prior-art overlap, claim/evidence ratio. Why no single signal is sufficient.
- **The "slop vs. real" false-positive problem.** Real bugs written by ESL researchers, junior researchers, or anyone in a hurry can score similarly to LLM-generated noise. How we try not to punish them, and where we still get it wrong.
- **What changed in 2025.** Concrete shifts in submission volume and shape since the GPT-4-class and Claude-3-class models became free-tier-accessible to anyone with a bounty platform login.
- **Maintainer burnout as a security risk.** Slop doesn't just waste time — it trains maintainers to reflexively close reports, which is how real bugs get missed. The second-order effect is the scarier one.
- **The economics.** Why "just charge $1 to submit a report" doesn't fix this, and what does seem to move the needle (reputation systems, platform-level pre-screening, public scoring).
- **What we deliberately don't do.** We don't auto-close reports, we don't sell to the platforms, we don't fine-tune on private data. Why those constraints matter.
- **Open data.** What pieces of our corpus and methodology are public, and what we're working on releasing next.
- **Where the engine is wrong.** A self-roast segment — categories where our score disagrees with expert human triage and we've had to recalibrate.

---

## 5 episode hooks

Each of these can carry an episode on its own. Pick the one that matches the show's vibe; don't offer all five at once.

1. **"We scored 10,000 vulnerability reports. Here's what AI slop actually looks like."**
   Data-forward episode. Charts, numbers, surprising findings. Best for shows with a research/data audience (Risky Business, Security. Cryptography. Whatever., Day[0]).

2. **"The real bugs hiding inside fake-looking reports."**
   Three anonymized case studies of reports that _looked_ AI-generated, scored low, and turned out to describe real, exploitable issues. Best for narrative-driven shows (Darknet Diaries, Malicious Life, Click Here).

3. **"Score this live: a vuln triage game show."**
   Host reads a report on-air, guesses the score, then we reveal what VulnRap gave it and why. Works as a recurring segment. Best for conversational/panel shows (Security Now, SANS Stormcast bonus episodes, Hacking Humans).

4. **"The maintainer side: what curl, Django, and the kernel security teams are seeing."**
   We co-host with a maintainer (we can bring one). Focus on the human cost, not the tech. Best for shows that cover open-source policy (Click Here, Risky Business, Open Source Security Podcast).

5. **"Is your bug report slop? A field guide for human researchers who don't want to be mistaken for bots."**
   Practical, actionable, listener-facing. The episode someone shares with a junior teammate. Best for shows with a lot of working-practitioner listeners (Security Now, Day[0], 7 Minute Security).

---

## Host bio template

Send the short version by default. Offer the long version if asked.

### Short (for show notes, ~60 words)

> {{founder_name}} is the founder of VulnRap, a free public scoring engine for vulnerability reports. Before VulnRap, {{founder_name}} spent {{N}} years in {{prior_role_short}} — most recently {{most_recent_role}}. {{founder_name}} writes about disclosure, triage economics, and AI-generated security noise at {{blog_or_handle}}, and is based in {{city}}.

### Long (for press kits, ~150 words)

> {{founder_name}} is the founder of VulnRap, a free public credibility-scoring engine for vulnerability reports used by maintainers, PSIRTs, and independent triagers to filter the rising tide of AI-generated bug reports without silencing legitimate researchers.
>
> Before founding VulnRap, {{founder_name}} {{prior_role_long_paragraph}}. That work led directly to VulnRap: the realization that the disclosure pipeline was breaking under volume, and that "just hire more triagers" was not a real answer.
>
> {{founder_name}} has spoken at {{conference_list}} and writes about vulnerability triage, scoring methodology, and the economics of disclosure at {{blog_url}}. {{founder_name}} holds {{credentials_if_relevant_else_omit_this_sentence}} and is based in {{city}}.
>
> Pronouns: {{pronouns}}. Available for remote interviews in English{{other_languages_if_any}}.

### Assets to attach

- Headshot: square, 1024×1024 minimum, neutral background. Path: `assets/press/{{founder_name}}-headshot.jpg`.
- Logo: SVG and PNG (transparent). Path: `assets/press/vulnrap-logo.{svg,png}`.
- One-line company description (matches Variant 1 above).

---

## Scheduling & availability

Include this verbatim in the first email — do not make the host chase us for it.

> **Time zones we can record from:** UTC, US/Eastern, US/Pacific, CET. Founder is based in {{city}}; co-founder available as backup guest in {{co_founder_city}}.
>
> **Recording windows:** Monday–Friday, 13:00–22:00 UTC. Weekends possible with one week of notice.
>
> **Lead time:** Two weeks preferred, one week workable, 48 hours possible for breaking-news segments.
>
> **Setup:** Shure SM7B into a Focusrite interface, treated room, wired ethernet. Riverside, Zencastr, SquadCast, Cleanfeed, or Zoom — whatever the show prefers. Can also record locally and upload a WAV.
>
> **Backup audio:** Always recorded locally on our end as a fail-safe; we'll send the raw track within 24 hours of recording if requested.
>
> **Pre-interview call:** Happy to do a 15-minute prep call the week before. Not required.
>
> **Topics off-limits:** None — but we'll politely decline to name specific bug bounty platforms, researchers, or maintainers in any context that could be read as throwing them under the bus. Anonymized examples are fine.
>
> **Booking contact:** {{booking_email}} (replies within one business day) or {{booking_handle}} on Signal.

---

## Follow-up cadence

If you don't hear back:

- **Day 0:** Initial pitch.
- **Day 8:** Short bump — one paragraph, reference one new data point or news hook from that week. Do not resend the full pitch.
- **Day 22:** Final bump — offer to revisit in a quarter, leave the door open. Do not bump a third time.

After three sends with no reply, the answer is no. Move on. Re-pitch in six months only if we have a substantively new angle (new data, new feature, new co-host).

---

## What not to do

- Don't pitch all five hooks at once. Pick one.
- Don't attach a slide deck to a cold email. Link to the docs site instead.
- Don't pitch us as "the leader in AI-powered vulnerability scoring." We're not, and hosts will roll their eyes.
- Don't ask for sponsorship and a guest spot in the same email. Two separate conversations, two separate threads, ideally two separate weeks.
- Don't follow up on the same day. Don't follow up on a Friday afternoon. Don't follow up during a major incident week (the host is busy).
- Don't claim exclusivity ("we'll only do this on your show") unless we genuinely mean it for that one show.
