# Link Unfurl Validation Checklist

Validates that shared VulnRap report links (`/results/:id`) render a rich
preview card in chat apps and social platforms.

## Architecture

1. **Static fallback** — `index.html` ships with generic OG tags pointing at
   `/opengraph.jpg`. Crawlers that hit non-report pages see this default card.
2. **Server-side injection** — When the Express SPA fallback serves
   `/results/:id`, it reads the report from the database and rewrites the OG
   meta tags inline before sending the HTML. This runs *before* any JavaScript
   executes, so headless crawlers that never run JS still see the correct
   per-report card.
3. **Dynamic OG image** — `/api/og/result/:id.png` renders a 1200×630 PNG via
   resvg (SVG → PNG) with the report's slop score, tier color, top signal,
   and branding. Both `og:image` and `twitter:image` point here.

## Platform Checklist

| # | Platform | What to check | Expected result | Notes |
|---|----------|---------------|-----------------|-------|
| 1 | **Twitter / X** | Paste `https://vulnrap.com/results/<id>` into a tweet draft, or use [Twitter Card Validator](https://cards-dev.twitter.com/validator) | `summary_large_image` card with the dynamic 1200×630 PNG showing the slop score and tier color | Twitter caches aggressively — append `?v=<random>` to bust cache during testing. Card validator no longer available publicly; test via a draft tweet instead. |
| 2 | **Slack** | Paste the URL in any Slack channel | Rich unfurl with title "VulnRap Report VR-{id} — Slop Score: X/100 (Tier)", description, and the dynamic PNG preview | Slack uses server-rendered HTML; no JS execution. Unfurl appears within seconds. Use `/unfurl <url>` in a DM to re-fetch. |
| 3 | **Discord** | Paste the URL in any Discord channel | Embed with og:title, og:description, and the 1200×630 image | Discord caches embeds ~15 min. Test in a private channel; delete and re-paste to re-fetch. |
| 4 | **LinkedIn** | Use [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) or paste in a post draft | Card with title, description, and preview image | LinkedIn caches heavily. Use Post Inspector to force a re-scrape. |
| 5 | **iMessage** | Send the link in an iMessage conversation | Rich link preview with title, image, and domain | iOS fetches OG tags server-side via Apple's link preview service. No JS execution. |
| 6 | **Telegram** | Paste the URL in any chat | Instant preview with title, image, description | Telegram's @WebPageBot can be used to force a re-fetch. |

## Automated Tests

Run from `artifacts/api-server/`:

```bash
# Unit tests — injection logic, path extraction, HTML escaping
npx vitest run src/lib/og-meta-injection.test.ts

# E2E tests — full pipeline: seed report → buildOgMetaForReport → injectOgMeta
# on real index.html → assert absolute URLs, correct content-type, valid PNG
npx vitest run src/lib/og-meta-injection.e2e.test.ts

# OG card image endpoint — PNG rendering, dimensions, ETag, 304 path, fallback
npx vitest run src/routes/og-card.route.test.ts
```

### What the automated tests assert

- `og:image` and `twitter:image` point at absolute `https://` URLs
- Both image URLs use the dynamic `/api/og/result/:id.png` endpoint (not the
  static `opengraph.jpg`)
- `og:image:type` is `image/png` (not `image/jpeg`) for the dynamic card
- `og:image:width` = 1200, `og:image:height` = 630
- `og:title` contains the report code (`VR-{id}`) and numeric score
- `og:url` is the canonical `/results/:id` page with an absolute URL
- `twitter:card` = `summary_large_image`
- The dynamic image URL resolves to a valid 1200×630 PNG (verified via IHDR)
- Hidden reports (`showInFeed=false`) and non-existent reports fall back to the
  static generic OG image
- HTML-special characters in titles/descriptions are properly escaped

## Validation Run Log

| Date | Platform | Method | Result | Notes |
|------|----------|--------|--------|-------|
| 2026-05-04 | **Automated (HTTP)** | `spa-fallback.integration.test.ts` — 10 tests fetching `/results/:id` via Express and asserting rewritten OG/Twitter tags in raw HTML | **PASS** | Verified: absolute `og:image` + `twitter:image` URLs, `image/png` type, `summary_large_image` card, report-specific title/description/url, fallback for hidden + non-existent reports, fallback for non-results pages |
| 2026-05-04 | **Automated (pipeline)** | `og-meta-injection.e2e.test.ts` — 11 tests running `buildOgMetaForReport` → `injectOgMeta` on real `index.html` | **PASS** | Verified: absolute URLs, PNG type rewrite, title with VR-id and score, canonical og:url, dynamic endpoint resolves to valid 1200×630 PNG |
| 2026-05-04 | **Automated (endpoint)** | `og-card.route.test.ts` — 10 tests hitting `/api/og/result/:id.png` | **PASS** | Verified: 1200×630 PNG, correct content-type, ETag + 304, redirect fallback for hidden/missing reports |

> **Note**: Real-world platform validation (Twitter Card Validator, Slack
> unfurl, Discord embed) requires a publicly accessible deployment. The
> automated tests above confirm the server returns correctly rewritten HTML
> with absolute URLs and valid PNG images — the same content these platforms
> will receive when they crawl the deployed site.

## Bugs Found & Fixed

1. **Unfurlers never saw the dynamic card** — The OG meta tags were only set
   client-side via React `useEffect`. Since unfurlers (Twitter, Slack, Discord,
   LinkedIn, iMessage, Telegram) do not execute JavaScript, they always saw the
   static `opengraph.jpg` from `index.html`. Fixed by adding server-side OG
   meta tag injection in the Express SPA fallback handler.

2. **`og:image:type` mismatch** — `index.html` declared `og:image:type` as
   `image/jpeg` (correct for the static `opengraph.jpg` fallback), but the
   dynamic card endpoint returns `image/png`. The server-side injection now
   rewrites `og:image:type` to `image/png` for report pages.

3. **Missing `og:title` / `og:description` / `twitter:title` /
   `twitter:description` rewrite** — Even if the image URL had been correct,
   unfurlers would have shown the generic site title instead of the
   report-specific title with score and tier. The injection now rewrites all
   title and description meta tags.
