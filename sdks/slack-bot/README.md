# VulnRap Slack Bot

A reference Slack bot that exposes a `/vulnrap <report-id>` slash command. Drop it into your security team's workspace so triage threads can pull a VulnRap score without leaving Slack.

This is a **recipe**, not a hosted service — you create the Slack app, run the bot wherever you like, and point it at the public VulnRap API (or your self-hosted instance).

## What you get

- `/vulnrap <id>` — looks the report up via `GET /api/reports/:id/verify` plus `GET /api/reports/:id` and replies in-channel with a card showing the slop score, tier, similarity / section-reuse counts, the top fired evidence signals, and a button that opens the full report on vulnrap.com.

The card emoji shifts from green (clean / likely human) through amber to red (slop), so you can eyeball severity at a glance.

## Prerequisites

- Node.js 18.17 or newer (uses the built-in `fetch`).
- A Slack workspace where you can install apps (or admin approval to do so).

## 1. Create the Slack app

The fastest path is the bundled [`manifest.json`](./manifest.json), which pre-declares the slash command, scopes, and Socket Mode setting.

1. Open <https://api.slack.com/apps> and click **Create New App → From an app manifest**.
2. Pick the workspace you want to install into.
3. Paste the contents of `manifest.json` into the JSON tab and click **Create**.
4. On the **Basic Information** page, under **App-Level Tokens**, click **Generate Token and Scopes**, name it `socket`, and add the `connections:write` scope. Copy the resulting `xapp-…` token — this is your `SLACK_APP_TOKEN`.
5. Still on **Basic Information**, copy the **Signing Secret** — this is your `SLACK_SIGNING_SECRET`.
6. In the left nav, open **Install App** and click **Install to Workspace**. Approve the scopes. Copy the **Bot User OAuth Token** (`xoxb-…`) — this is your `SLACK_BOT_TOKEN`.

> Prefer to click through the UI instead of using the manifest? Create the app **From scratch**, then under **Slash Commands** add `/vulnrap` (usage hint: `<report-id>`), under **OAuth & Permissions** add the `commands`, `chat:write`, and `chat:write.public` bot scopes, and under **Socket Mode** toggle it on and generate the app-level token described above.

## 2. Configure and install

```bash
cd sdks/slack-bot
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET
npm install
```

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth Token (`xoxb-…`) from **OAuth & Permissions**. |
| `SLACK_APP_TOKEN` | yes | App-level token (`xapp-…`) with `connections:write`, used for Socket Mode. |
| `SLACK_SIGNING_SECRET` | recommended | Signing secret from **Basic Information**. Bolt always validates it when present. |
| `VULNRAP_API_BASE` | no | Defaults to `https://vulnrap.com/api`. Override for self-hosting. |
| `VULNRAP_PUBLIC_URL` | no | Defaults to `https://vulnrap.com`. Used to build "Open report" links if the API doesn't return one. |

## 3. Run

```bash
npm start
```

You should see `VulnRap Slack bot running in Socket Mode.` in the console. In any channel the bot has access to, type `/vulnrap 1234` (or whatever report id you want to look up) and you'll get an in-channel card back. Invalid ids and missing reports are returned as ephemeral messages so they don't clutter the channel.

Because the bot uses **Socket Mode**, it does not need a public HTTPS endpoint — it opens an outbound websocket to Slack and receives slash commands over that connection.

## 4. (Optional) Deploy

Hosting is intentionally out of scope for this recipe — the bot is a single long-running Node process that talks to Slack over a websocket and to the VulnRap API over HTTPS, so almost anything works:

- A small VM or container (`npm start` under systemd, PM2, or `docker run`).
- A serverless container platform (Fly.io, Render, Railway, Cloud Run with min-instances=1).
- A Replit Reserved VM deployment if you cloned this monorepo into Replit.

Whatever you pick, set the env vars on the host and make sure the process can stay online — Slack will surface "dispatch_failed" errors to users if the websocket drops while a command is in flight.

## Troubleshooting

- **"dispatch_failed" in Slack.** The bot process isn't running, or its `SLACK_APP_TOKEN` is missing the `connections:write` scope. Restart the bot and confirm the token starts with `xapp-`.
- **`invalid_auth` on startup.** The `SLACK_BOT_TOKEN` is wrong or the app hasn't been installed to the workspace. Re-run **Install App → Install to Workspace** and copy the fresh `xoxb-…` token.
- **Card shows "Could not reach VulnRap API".** Confirm `VULNRAP_API_BASE` is reachable from the host (`curl $VULNRAP_API_BASE/healthz`).
- **"does not look like a numeric report id".** The `/verify` endpoint takes the integer id from the URL (the `1234` in `vulnrap.com/results/1234`), not the human-readable `VR-000B` code. The bot will strip a leading `#` or `VR-` prefix for you.

## Files

- `index.js` — bot runtime: connects via Socket Mode, handles `/vulnrap` slash commands, builds the Block Kit card.
- `manifest.json` — Slack app manifest you can paste into "Create New App → From an app manifest".
- `package.json` — `@slack/bolt` + `dotenv`, plus a `start` script.
- `.env.example` — template for local config.
