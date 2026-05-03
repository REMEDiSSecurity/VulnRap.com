# VulnRap "Check selection" Bookmarklet

A one-line browser bookmarklet that grabs the currently selected text on any
web page and opens [`https://vulnrap.com/check`](https://vulnrap.com/check)
with that text pre-filled in the textarea. Lower-friction than installing a
full browser extension — works in any modern browser that supports a
bookmarks bar (Chrome, Firefox, Safari, Edge, Brave, Arc, ...).

## Install

The easy path: visit [`/developers`](https://vulnrap.com/developers) and drag
the **Check selection on VulnRap** button onto your bookmarks bar. Done.

The manual path: copy the contents of `vulnrap.bookmarklet.url` (in this
folder) into a new bookmark's URL field. The string starts with `javascript:`.

## Use

1. Select any block of text on any page (a HackerOne report, a Bugcrowd
   submission, a chat message, an email, …).
2. Click the bookmark.
3. A new tab opens at `/check?text=<your selection>` — review the textarea,
   adjust if needed, then click **Check** to score it.

If nothing is selected the bookmarklet still opens `/check`, just empty.

## Limits

- Selections longer than 50,000 characters are truncated. The `/check`
  endpoint accepts more, but URL length limits in browsers (and intermediate
  proxies) make a longer query string unreliable.
- Selection inside cross-origin iframes is invisible to the bookmarklet —
  this is a browser security boundary, not something we can work around.
- The bookmarklet does **not** auto-submit. You always click **Check** in
  `/check` yourself. (See `## Out of scope` in the task that birthed this.)

## What ships

| File                      | Purpose                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/bookmarklet.js`      | Hand-written IIFE source — the thing you'd review.                                                    |
| `generate.mjs`            | Tiny Node script that minifies the source and emits the artifacts below. No third-party dependencies. |
| `vulnrap.bookmarklet.js`  | Minified IIFE (the body of the `javascript:` URL).                                                    |
| `vulnrap.bookmarklet.url` | The full `javascript:`-prefixed href, ready to paste into a bookmark.                                 |

`artifacts/vulnrap/public/vulnrap.bookmarklet.js` is a mirror of the minified
JS so the `/developers` page can serve it same-origin without a GitHub
round-trip.

## Regenerate

```bash
pnpm --filter @workspace/scripts run generate:bookmarklet
# or directly:
node sdks/bookmarklet/generate.mjs
```

The generated files are checked in so the website can ship a stable artifact
without contributors needing to run anything.
