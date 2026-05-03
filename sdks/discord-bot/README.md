# VulnRap Discord Bot

A reference Discord bot that exposes a `/vulnrap-score <id>` slash command. Drop it into your security team's Discord server so triage threads can pull a VulnRap score without leaving chat.

This is a **recipe**, not a hosted service — you create the Discord application, run the bot wherever you like, and point it at the public VulnRap API (or your self-hosted instance).

## What you get

- `/vulnrap-score <id>` — looks the report up via `GET /api/reports/:id` and replies with an embed showing the slop score, tier, similarity match count, section-reuse count, the **top fired signals** (up to 3, ranked by weight), and a link to open the full report on vulnrap.com. If the full-report fetch fails, the bot falls back to the lighter `GET /api/reports/:id/verify` badge so the command still produces a useful embed (without the top-signals field). Accepts either the numeric id from the URL (`1234`) or the human-readable report code (`VR-000B`, or the bare hex `000B` / `0010`) — the bot decodes the hex code locally to the underlying id before calling the API, so no extra round-trip is needed.

  Bare inputs are interpreted as a report code when they contain a hex letter (`abcd`) or a leading zero (`0010`), and otherwise as a decimal id. A bare 4-digit input with no leading zero (e.g. `1234`) is therefore always treated as a decimal URL id; if you specifically need that range as a report code, prefix it with `VR-` (`VR-1234`).

The embed color shifts from green (clean / likely human) through amber to red (slop), so you can eyeball severity at a glance. The "Top signals" field surfaces the highest-weight evidence items the engine fired (e.g. `ai_phrase`, `placeholder_url`, `severity_inflation`) so reviewers can triage in-channel without clicking through.

## Prerequisites

- Node.js 18.17 or newer (uses the built-in `fetch`).
- A Discord account with permission to create applications.

## 1. Create the Discord application

1. Open <https://discord.com/developers/applications> and click **New Application**. Name it something like `VulnRap`.
2. In the **Bot** tab, click **Reset Token** and copy the token — you will paste it into `.env` as `DISCORD_TOKEN`. Treat it like a password.
3. Still on the **Bot** tab, you do **not** need to enable any privileged intents. The bot only uses slash commands, which work over Discord's interaction gateway with the default `Guilds` intent.
4. In the **OAuth2 → General** tab, copy the **Application ID** (a numeric string). This is your `DISCORD_CLIENT_ID`.

## 2. Invite the bot to your server

In the **OAuth2 → URL Generator** tab:

- **Scopes**: `bot`, `applications.commands`
- **Bot permissions**: `Send Messages`, `Embed Links`, `Use Slash Commands`

Open the generated URL in a browser and pick the server you want to install into. You need **Manage Server** permission on that server.

If you want the slash command to appear instantly while you're developing, grab the server's id (Discord → User Settings → Advanced → enable Developer Mode, then right-click the server icon → Copy Server ID) and put it in `.env` as `DISCORD_GUILD_ID`. Guild-scoped commands update immediately; global commands can take up to an hour to propagate.

## 3. Configure and install

```bash
cd sdks/discord-bot
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, and (optionally) DISCORD_GUILD_ID
npm install
```

Environment variables:

| Variable             | Required | Description                                                                                              |
| -------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`      | yes      | Bot token from the Discord developer portal.                                                             |
| `DISCORD_CLIENT_ID`  | yes      | Application id from the developer portal.                                                                |
| `DISCORD_GUILD_ID`   | no       | If set, the slash command is registered to that single guild (instant). Otherwise it registers globally. |
| `VULNRAP_API_BASE`   | no       | Defaults to `https://vulnrap.com/api`. Override for self-hosting.                                        |
| `VULNRAP_PUBLIC_URL` | no       | Defaults to `https://vulnrap.com`. Used to build "Open report" links if the API doesn't return one.      |

## 4. Register the slash command and run

```bash
npm run register   # publishes /vulnrap-score to Discord
npm start          # logs the bot in and starts handling interactions
```

You should see `Logged in as VulnRap#1234` in the console. In your server, type `/vulnrap-score 1234` (the numeric id from the report URL) or `/vulnrap-score VR-000B` (the human-readable code shown on the report page) and you'll get an embed back.

## 5. (Optional) Deploy

Hosting is intentionally out of scope for this recipe — the bot is a single long-running Node process that talks to Discord over a websocket and to the VulnRap API over HTTPS, so almost anything works:

- A small VM or container (`npm start` under systemd, PM2, or `docker run`).
- A serverless container platform (Fly.io, Render, Railway, Cloud Run with min-instances=1).
- A Replit Reserved VM deployment if you cloned this monorepo into Replit.

Whatever you pick, set the env vars on the host and make sure the process can stay online — Discord will mark the bot offline if the websocket drops.

## Troubleshooting

- **"Missing Access" or no command appears.** Re-invite the bot with the `applications.commands` scope, or set `DISCORD_GUILD_ID` and re-run `npm run register` — global registration can take up to an hour.
- **Embed shows "Could not reach VulnRap API".** Confirm `VULNRAP_API_BASE` is reachable from the host (`curl $VULNRAP_API_BASE/healthz`).
- **"does not look like a VulnRap report reference".** The argument must be either the numeric id from the URL (`1234` in `vulnrap.com/results/1234`) or the report code shown on the page (`VR-000B`, or the bare hex `000B` / `0010`). Anything else — search terms, full URLs, prose — is rejected. If your bare input is all decimal digits with no leading zero, the bot reads it as a decimal id; prefix it with `VR-` to force the report-code interpretation.

## Tests

```bash
npm test   # runs sdks/discord-bot/parse-report-id.test.js
```

The test suite covers the input parser (decimal ids, prefixed `VR-XXXX`
codes, bare hex codes including the numeric-only `0010` form, and the
junk-input rejection paths).

## Files

- `index.js` — bot runtime: logs in, handles `/vulnrap-score` interactions, builds the embed.
- `parse-report-id.js` — input parser that resolves `1234`, `VR-000B`, and bare hex codes (`000B`, `0010`) to the underlying numeric report id.
- `parse-report-id.test.js` — node-only assertions for the parser.
- `commands.js` — slash command schema (shared by the runtime and the registration script).
- `deploy-commands.js` — one-shot script that publishes the slash command to Discord.
- `package.json` — `discord.js` + `dotenv`, plus `start` / `register` scripts.
- `.env.example` — template for local config.
