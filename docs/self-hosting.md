# Self-hosting VulnRap

VulnRap is a single self-contained Node application plus a Postgres database.
The repo ships a production `Dockerfile` and a full-stack
`docker-compose.yml` so a self-hoster on any container-capable host can go
from a fresh clone to a running instance with one command.

This guide is the long-form companion to the `Dockerfile`. It covers
prerequisites, configuration, first-run migrations, log/volume layout,
backup, upgrades, and the small set of Replit-specific behaviours that are
intentionally absent from the container.

> **Heads up:** Self-hosting gives you a fully functional VulnRap instance
> — report submission, auto-redaction, scoring, similarity matching within
> your own database, and the entire UI. The only thing it cannot do is
> cross-reference reports submitted by other organizations; that requires
> the shared fingerprint database hosted at
> [vulnrap.com](https://vulnrap.com). See
> [Local vs Hosted](../README.md#local-vs-hosted) for the trade-off.

---

## 1. Prerequisites

- Docker Engine 24+ (or Docker Desktop) and the `docker compose` v2 plugin.
- ~1 GB of free disk for the image + a small amount for the Postgres
  volume (grows with the number of stored reports — typically a few MB
  per thousand reports).
- An open inbound port for the api-server (default `8080`).

> Building the image needs a few extra GB of scratch space because of the
> npm build cache. Once built, the runtime image itself is small.

That's it. You do **not** need Node, pnpm, or PostgreSQL installed on the
host — the container provides all of them.

---

## 2. Configure

```bash
git clone https://github.com/REMEDiSSecurity/VulnRap.Com.git
cd VulnRap.Com
cp .env.example .env
```

Edit `.env`. The defaults are a good starting point for a single-host
deployment behind a reverse proxy on `localhost:8080`. The variables that
matter most:

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `8080` | Port the api-server (and the bundled SPA) listens on. |
| `DATABASE_URL` | host-dev only | The value in `.env.example` is a `localhost`-flavoured URL aimed at host-side `pnpm dev`. **Under `docker compose up` it is intentionally ignored** — the compose file wires the `app` service at the bundled `db` service so the container never accidentally targets itself. To use an external Postgres, see [Using an external Postgres](#using-an-external-postgres). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `vulnrap` / `vulnrap` / `vulnrap` | Bundled Postgres credentials. Used by both the `db` service and the in-container `DATABASE_URL` the compose file builds, so changing `POSTGRES_PASSWORD` here keeps both sides in sync. **Change `POSTGRES_PASSWORD` before exposing the host to the public internet.** |
| `POSTGRES_PORT` | `5432` | Host port the bundled Postgres binds. Change if 5432 is already in use on the host. |
| `PUBLIC_URL` | `http://localhost:8080` | Used to build canonical URLs (sitemap, security.txt, OG tags, share links). Set to `https://your-domain.example` once you put a TLS terminator in front. |
| `ALLOWED_ORIGINS` | `http://localhost:8080` | Comma-separated CORS allow-list. Add the public origin you serve under. |
| `OPENAI_API_KEY` | empty | Optional. Enables the LLM semantic-analysis axis. Heuristic-only scoring works without it. |
| `OPENAI_BASE_URL` | empty | Optional. Point at any OpenAI-compatible endpoint (Ollama, vLLM, Azure OpenAI, …). |
| `OPENAI_MODEL` | empty | Optional. Defaults to `gpt-5-nano` inside the api-server. |

---

## 3. Bring it up

```bash
docker compose up -d --build
```

The first run does three things automatically:

1. Builds the production image (multi-stage, runs as a non-root user).
2. Starts Postgres with a named volume (`vulnrap_pgdata`) so data
   survives container restarts.
3. Starts the api-server, which on boot runs the bundled
   `runStartupMigrations` to bring the schema up to date and then begins
   serving the SPA + the API on `$PORT`.

Wait for the healthcheck to flip to `healthy`:

```bash
docker compose ps
```

Then open <http://localhost:8080>.

> Need just Postgres for host-side dev work? Use the legacy db-only
> profile: `docker compose --profile db-only up -d`. The `app` service
> stays out of the picture so you can `pnpm --filter @workspace/api-server
> run dev` against the same database from your host.

---

## 4. First-run migrations

The api-server applies its additive migrations on startup
(`runStartupMigrations` in `artifacts/api-server/src/lib/startup-migrations.ts`).
You do not need to run a separate `pnpm migrate` step — the container
takes care of it. If you want to inspect what was applied, follow the
container logs while it boots:

```bash
docker compose logs -f app
```

To force a clean re-bootstrap (drops + recreates the schema):

```bash
docker compose down                         # stops, keeps the volume
docker compose down -v                      # stops AND deletes the DB volume
docker compose up -d --build
```

> `down -v` is destructive. Use it for a fresh start, never against a
> volume you care about.

---

## 5. Logs & volumes

| What | Where |
|------|-------|
| api-server logs | `docker compose logs app` (or `docker logs <container>`) |
| Postgres logs | `docker compose logs db` |
| Postgres data | named volume `vulnrap_pgdata` (managed by Docker; see `docker volume inspect vulnrap_pgdata`) |
| Healthcheck endpoint | `GET /api/healthz` — returns 200 with `{"status":"ok"}` once boot finishes |

The api-server logs are pino JSON by default. Pipe them through
`pino-pretty` on the host if you want a colourised view:

```bash
docker compose logs -f app | npx pino-pretty
```

---

## 6. Backups

The only stateful surface is Postgres. Two equivalent options:

**Logical backup (recommended for portability across versions):**

```bash
docker compose exec -T db \
  pg_dump -U vulnrap -d vulnrap --format=custom \
  > vulnrap-$(date +%F).dump
```

Restore:

```bash
docker compose exec -T db \
  pg_restore -U vulnrap -d vulnrap --clean --if-exists < vulnrap-2026-05-03.dump
```

**Physical volume snapshot (faster, version-pinned):**

```bash
docker run --rm \
  -v vulnrap_pgdata:/data \
  -v "$PWD":/backup \
  alpine tar -czf /backup/vulnrap-pgdata-$(date +%F).tar.gz -C /data .
```

Schedule one of these from cron / your VPS provider's snapshot system.

---

## 7. Upgrading

```bash
git pull
docker compose build --pull            # rebuild against the latest base image
docker compose up -d
```

The api-server applies any new additive migrations on the next boot.
There is no separate "migrate then start" step. If a release ever
requires destructive schema work, the release notes will say so
explicitly.

---

## 7a. Using an external Postgres

The bundled `db` service is the simplest option, but you can point the
container at an existing Postgres (RDS, Cloud SQL, a hand-rolled VM,
etc.) two ways:

**Per-invocation, with `docker run`:**

```bash
docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgresql://USER:PASS@HOST:5432/DB \
  -e PUBLIC_URL=https://your-domain.example \
  -e ALLOWED_ORIGINS=https://your-domain.example \
  vulnrap:local
```

**Persistently, with a compose override** — drop a
`docker-compose.override.yml` next to the bundled compose file:

```yaml
services:
  app:
    environment:
      DATABASE_URL: postgresql://USER:PASS@HOST:5432/DB
    depends_on: !reset []
  db:
    profiles: ["disabled"]
```

The override (a) replaces the in-cluster `DATABASE_URL`, (b) drops the
`db` healthcheck dependency, and (c) parks the bundled Postgres behind
an unused profile so `docker compose up` no longer starts it.

> The reason `.env`'s `DATABASE_URL` is *not* threaded through to the
> `app` container is that the same file is also used for host-side `pnpm
> dev`, where `localhost` is the right target. Threading it through
> would silently break the in-container default. The override file
> pattern keeps both flows correct.

---

## 8. Putting it behind a reverse proxy / TLS

The image speaks plain HTTP. Front it with whatever you already use —
Caddy, nginx, Traefik, Cloudflare Tunnel — and:

- Forward to `app:8080` (or whatever `$PORT` you chose).
- Set `PUBLIC_URL=https://your-domain.example` in `.env` so canonical
  URLs and `security.txt` reflect the public origin.
- Add the public origin to `ALLOWED_ORIGINS`.
- The api-server already trusts `X-Forwarded-*` from the first proxy hop
  (`app.set("trust proxy", 1)` in `artifacts/api-server/src/app.ts`), so
  rate limiting and `req.ip` see the real client IP without further
  configuration.

A custom domain is whatever your DNS / proxy points at the host — there
is no Replit-style domain registration to coordinate.

---

## 9. What's different from running on Replit

The container is intentionally portable, which means a few Replit-only
behaviours are NOT in the image. None of them are required for a
functional self-hosted instance, but if you're coming from the hosted
deployment it's useful to know what the equivalents are:

| Replit-only | Self-hosted equivalent |
|-------------|------------------------|
| `.replit` workflows (`Project`, `artifacts/api-server: API Server`, `artifacts/vulnrap: web`) | `docker compose up` runs the same processes — there is one container instead of two workflows because the api-server serves the SPA static assets directly in production. |
| Replit-managed secrets | Plain `.env` file consumed by `docker compose`. |
| Replit Object Storage | Not used by VulnRap today — the codebase persists everything in Postgres. If you fork to add file storage, swap in S3 / MinIO / a host volume. |
| Replit Deploy autoscale | Run multiple `app` replicas behind your proxy of choice and point them at the same Postgres. |
| Playwright-driven SPA prerender | The container builds the SPA with `build:no-prerender` to keep the image small (no chromium binary). The SPA is fully functional client-side; prerendering is a hosted-only SEO optimisation. |

---

## 10. Troubleshooting

- **`docker compose up` exits immediately with `PORT environment variable is required`** — your `.env` is missing `PORT`. Copy from `.env.example`.
- **`Could not load OpenAPI spec for Swagger UI`** — the `openapi.yaml` is not present next to `dist/index.mjs`. The Dockerfile copies it via `pnpm --filter @workspace/api-server run build`; if you are running a hand-rolled image, make sure `artifacts/api-server/dist/openapi.yaml` exists.
- **Healthcheck stuck at `starting`** — tail `docker compose logs app`. Common causes: bad `DATABASE_URL`, Postgres not yet healthy (the compose dependency waits for it but external databases don't), startup migrations failed.
- **CORS errors from a browser hitting `/api/...`** — add the origin you're loading the SPA from to `ALLOWED_ORIGINS`.
- **Image build is slow** — the first build downloads pnpm + every workspace dep. Subsequent builds reuse the `deps` layer unless `pnpm-lock.yaml` or any `package.json` changes.

---

## 11. Out of scope (today)

- **Kubernetes manifests / Helm chart.** The single-container model
  covers the common self-hoster. If there is demand we'll add one as a
  follow-up.
- **Multi-arch image builds (`linux/arm64`).** The Dockerfile does not
  intentionally prevent it, but the CI matrix only builds `linux/amd64`
  today. `docker buildx build --platform linux/arm64 .` should work
  locally on an arm host or with QEMU.
- **Switching the Replit deployment to use this image.** Replit Deploy
  keeps its current path; this Dockerfile exists for self-hosters.

---

Questions, bugs, or improvements: open an issue at
<https://github.com/REMEDiSSecurity/VulnRap.Com/issues>.
