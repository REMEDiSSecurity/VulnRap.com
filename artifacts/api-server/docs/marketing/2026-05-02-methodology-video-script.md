# Methodology Video — Script + Storyboard

**Published:** 2026-05-02
**Format:** 90-second screen recording with voiceover, embedded on the home page above the fold (below the headline, above the paste-a-report demo).
**Audience:** Triagers, program managers, and curious researchers who land on the home page and want to know — in plain English — what VulnRap actually does before they trust it.

---

## Goals

1. Explain what VulnRap is, what it scores, and why anyone should care — in under 90 seconds.
2. Show the tool actually working on a real-looking pasted report. No mock screens.
3. End on a single call to action: paste your own report.
4. Stay non-technical. Any acronym (CWE, PoC, AVRI) gets spelled out the first time it appears on screen _and_ in the voiceover.

## Pacing target

- 90 seconds total.
- ~135 words per minute = ~200 words of voiceover, give or take 10.
- 7 beats. Average 12-14 seconds each.

---

## Beat-by-beat script

Times are cumulative. "VO" is what the narrator says. "Screen" is what the viewer sees. "B-roll" is any cutaway, overlay, or text card layered on top.

### Beat 1 — The problem (0:00 – 0:12)

- **Screen:** The reports explorer (`/reports`) filtered to recent submissions. Camera slowly pans down a list of 30+ report titles. Pick three that read as visibly low-effort plain-English titles: "Login page is broken", "Critical bug found", "Site is hackable". (Avoid sample titles full of acronyms like RCE or XSS — the script's job is to coach non-technical viewers, not to test their jargon.)
- **VO:** "Bug bounty triagers open hundreds of reports a week. A growing share are written by artificial intelligence — AI — and they're confident, well-formatted, and wrong. Sorting real ones from that pile is now the job."
- **B-roll:** Subtle red highlight pulses on three of the obviously bad titles as the VO says "wrong."
- **Word count:** 36 words.

### Beat 2 — Introduce VulnRap (0:12 – 0:24)

- **Screen:** Cut to the VulnRap home page hero. Logo, tagline, the paste box.
- **VO:** "VulnRap is a free tool that reads a vulnerability report and tells you how likely it is to be real, reproducible work — versus generated slop."
- **B-roll:** Caption card slides in: _"Slop = low-effort or AI-fabricated reports."_ Stays on screen for 3 seconds.
- **Word count:** 26 words.

### Beat 3 — Paste a sample (0:24 – 0:36)

- **Screen:** Cursor clicks the paste box. A sample report appears (use the canned "fake-login-bug" example, e.g. `/examples/slop-1`). Title, body, and a fabricated stack trace are visible.
- **VO:** "Take this one. It cites a vulnerability ID — a CVE, short for Common Vulnerabilities and Exposures — that doesn't exist, points to a file that isn't in the code, and the steps to reproduce never run."
- **B-roll:** Three small annotation arrows appear, one per claim: "no such CVE", "no such file", "steps don't run." Each arrow appears synced to the matching word in the VO. The first arrow's tooltip also spells out _"CVE = Common Vulnerabilities and Exposures."_
- **Word count:** 36 words.

### Beat 4 — Engines fire (0:36 – 0:50)

- **Screen:** User clicks "Score this report." A side panel slides open showing five engines lighting up one at a time: Linguistic, Structural, Reproducibility, Cross-reference, and AVRI (Adversarial Vulnerability Reasoning Index). Each gets a green-checkmark or red-x as it finishes.
- **VO:** "Five engines look at the report from different angles: how it's written, how it's structured, whether the steps actually run, whether the citations exist, and whether the reasoning holds together."
- **B-roll:** As "AVRI" lights up, a small caption reads _"AVRI = Adversarial Vulnerability Reasoning Index."_
- **Word count:** 30 words.

### Beat 5 — Score appears (0:50 – 1:02)

- **Screen:** Final score animates in: a large number ("12 / 100 — Likely Slop") with a confidence band ("±4"). The five engine sub-scores are visible underneath, each with a one-line reason.
- **VO:** "You get one score from zero to a hundred, a confidence range, and a plain-English reason for every signal that fired."
- **B-roll:** Cursor hovers over one of the sub-scores; a tooltip expands showing the verbatim quote from the report that triggered it.
- **Word count:** 21 words.

### Beat 6 — Transparency dashboard (1:02 – 1:16)

- **Screen:** Cut to the transparency dashboard at `/transparency`. Scroll smoothly past: the per-signal precision/recall chart, the calibration curve, and the false-positive-rate-by-CWE (Common Weakness Enumeration) panel.
- **VO:** "Every score is auditable. We publish how often each signal is right, on what kinds of bugs, on public datasets. Disagree, and you can see exactly why."
- **B-roll:** Caption card on first appearance of CWE: _"CWE = Common Weakness Enumeration, the standard list of bug categories."_
- **Word count:** 28 words.

### Beat 7 — Call to action (1:16 – 1:30)

- **Screen:** Return to the home page paste box. Cursor blinks in the empty field. Text below the box reads "Paste any report. No login. No data stored."
- **VO:** "Paste your own report. No account needed, nothing stored. If we get it wrong, tell us — every disagreement is a calibration point."
- **B-roll:** End card: VulnRap wordmark, URL, and the line _"Free. Open methodology. No login."_
- **Word count:** 22 words.

**Total VO word count:** 199 words — lands at ~88 seconds at 135 words per minute, inside the 90-second window with a small breath buffer. Do not rush the score reveal in beat 5; if the narrator's natural pace is slower, the buffer between beats absorbs the slack.

> Note on Beat 7 wording: an earlier draft said "nothing leaves your browser." That overstates current behavior — the paste-box submits the report to the scoring API. The wording above ("nothing stored") matches the on-screen text under the paste box and the privacy policy. Re-verify both before recording.

---

## Shot list (for the recordist)

| #   | Page / URL                  | Action                                                                                | Notes                                                                                                       |
| --- | --------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | `/reports`                  | Slow downward scroll, ~10s, no clicks                                                 | Filter to recent submissions so the visible titles are the obviously low-effort ones. Capture at 1920×1080. |
| 2   | `/` (home)                  | Static hero, 2s hold                                                                  | Make sure the cookie banner is dismissed before recording.                                                  |
| 3   | `/` (home)                  | Click the paste box, paste the contents of the canonical sample at `/examples/slop-1` | Use a screen-recorder that shows the cursor; do not type — paste, so the timing is predictable.             |
| 4   | `/` (home)                  | Click "Score this report"                                                             | Engine panel must be in its default expanded state. If a user has collapsed it, reset local storage first.  |
| 5   | `/` (home)                  | Wait for the full score animation, then hover one sub-score                           | Hover the "Reproducibility" row — its tooltip is the most readable.                                         |
| 6   | `/transparency`             | Smooth scroll from top to the false-positive-rate (FPR) by CWE panel                  | ~14s scroll. Use a scripted scroll, not a trackpad, for consistent speed.                                   |
| 7   | `/` (home, scrolled to top) | Cursor in empty paste box, blinking                                                   | Hold for 4s to let the end card overlay land.                                                               |

**Recording notes**

- Browser: Chrome, 1920×1080, 100% zoom, no extensions visible.
- Theme: light mode. (Dark mode is fine for a B-version later.)
- Frame rate: 60fps source, export at 30fps.
- Mute the OS — capture VO separately and mix in post.
- The five-engine panel uses CSS animations; verify they actually played in the captured file before moving on.

---

## Subtitle file (SRT)

Save as `methodology-video.en.srt` next to the eventual MP4. Times match the beat structure above. Lines are kept under 42 characters where possible so they wrap cleanly on mobile.

```srt
1
00:00:00,000 --> 00:00:06,000
Bug bounty triagers open hundreds
of reports a week.

2
00:00:06,000 --> 00:00:12,000
A growing share are written by AI
(artificial intelligence) — and wrong.

3
00:00:12,000 --> 00:00:18,000
VulnRap is a free tool that reads
a vulnerability report

4
00:00:18,000 --> 00:00:24,000
and tells you how likely it is
real work — versus generated slop.

5
00:00:24,000 --> 00:00:30,000
Take this one. It cites a CVE
(Common Vulnerabilities and Exposures)

6
00:00:30,000 --> 00:00:36,000
that doesn't exist, and the steps
to reproduce never run.

7
00:00:36,000 --> 00:00:43,000
Five engines look at the report
from different angles:

8
00:00:43,000 --> 00:00:50,000
how it's written, how it's structured,
whether the steps actually run.

9
00:00:50,000 --> 00:00:56,000
You get one score from zero
to a hundred, with a confidence range,

10
00:00:56,000 --> 00:01:02,000
and a plain-English reason
for every signal that fired.

11
00:01:02,000 --> 00:01:09,000
Every score is auditable. We publish
how often each signal is right,

12
00:01:09,000 --> 00:01:16,000
on what kinds of bugs, on public
datasets. Disagree, and you'll see why.

13
00:01:16,000 --> 00:01:23,000
Paste your own report. No account
needed, nothing stored.

14
00:01:23,000 --> 00:01:30,000
If we get it wrong, tell us. Every
disagreement is a calibration point.
```

> Note: SRT cue 6 abbreviates the CVE expansion for line-length reasons. The full phrase "Common Vulnerabilities and Exposures" still appears in the spoken voiceover (beat 3) and as an on-screen B-roll tooltip, so non-technical viewers are coached on the acronym whether they're listening or reading.

---

## Publishing checklist

When the recording is finished and mixed, do these in order:

1. **Master file**
   - Export at 1920×1080, H.264, 30fps, target ~8 Mbps.
   - Filename: `methodology-2026-05.mp4`.
   - Also export a 720p version (`methodology-2026-05-720p.mp4`) for slow connections.

2. **Upload locations**
   - Primary: project's own object storage bucket (`marketing/videos/`), served via CDN. We do not want a third-party tracker on the home page.
   - Mirror: an unlisted YouTube upload at the same time, for users who prefer YouTube's player or want captions/translations later. Link from the `/transparency` page footer, _not_ from the home page.

3. **Embed location**
   - Home page (`/`), in a new section between the headline hero and the paste box.
   - Use a native `<video>` tag with `preload="metadata"`, `controls`, and a poster frame captured from beat 5 (the score reveal).
   - Autoplay: **off**. Muted-autoplay is also off — this is a methodology explainer, not a TikTok.
   - Wrap in a container that caps width at 960px so it doesn't dominate on wide monitors.

4. **Captions**
   - Ship the SRT above as `methodology-video.en.srt` in the same bucket.
   - Reference it via `<track kind="captions" srclang="en" label="English" src="..." default>`.
   - Captions on by default. Many viewers will be at work with sound off.

5. **Alt text and accessibility**
   - `aria-label` on the `<video>` element: _"90-second walkthrough of how VulnRap scores a vulnerability report. Captions available."_
   - Below the video, render a `<details>` block titled "Read the transcript instead" containing the full voiceover text from the beat list above. This is the canonical text alternative — do not skip it.
   - Confirm the video container is keyboard-focusable and that the play button is reachable via Tab.
   - Verify color contrast on the on-screen captions overlay meets WCAG AA against the brightest frame (the score reveal — white text on near-white background is the failure mode to watch for).

6. **Analytics**
   - Track only: play started, played to 25%, 50%, 75%, completed. No per-second pings, no fingerprinting.
   - Do not gate the video behind any consent banner — it's first-party hosted with no cookies.

7. **Post-publish**
   - Update `replit.md` with the embed location.
   - Add a row to the home-page A/B test log noting the date the video went live, so we can attribute any conversion-rate change.
   - File a follow-up to record a Spanish-language version once the English one has 30 days of viewing data.
