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

| Variable                                              | Default                           | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                | `8080`                            | Port the api-server (and the bundled SPA) listens on.                                                                                                                                                                                                                                                                                                                      |
| `DATABASE_URL`                                        | host-dev only                     | The value in `.env.example` is a `localhost`-flavoured URL aimed at host-side `pnpm dev`. **Under `docker compose up` it is intentionally ignored** — the compose file wires the `app` service at the bundled `db` service so the container never accidentally targets itself. To use an external Postgres, see [Using an external Postgres](#using-an-external-postgres). |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `vulnrap` / `vulnrap` / `vulnrap` | Bundled Postgres credentials. Used by both the `db` service and the in-container `DATABASE_URL` the compose file builds, so changing `POSTGRES_PASSWORD` here keeps both sides in sync. **Change `POSTGRES_PASSWORD` before exposing the host to the public internet.**                                                                                                    |
| `POSTGRES_PORT`                                       | `5432`                            | Host port the bundled Postgres binds. Change if 5432 is already in use on the host.                                                                                                                                                                                                                                                                                        |
| `PUBLIC_URL`                                          | `http://localhost:8080`           | Used to build canonical URLs (sitemap, security.txt, OG tags, share links). Set to `https://your-domain.example` once you put a TLS terminator in front.                                                                                                                                                                                                                   |
| `ALLOWED_ORIGINS`                                     | `http://localhost:8080`           | Comma-separated CORS allow-list. Add the public origin you serve under.                                                                                                                                                                                                                                                                                                    |
| `OPENAI_API_KEY`                                      | empty                             | Optional. Enables the LLM semantic-analysis axis. Heuristic-only scoring works without it.                                                                                                                                                                                                                                                                                 |
| `OPENAI_BASE_URL`                                     | empty                             | Optional. Point at any OpenAI-compatible endpoint (Ollama, vLLM, Azure OpenAI, …).                                                                                                                                                                                                                                                                                         |
| `OPENAI_MODEL`                                        | empty                             | Optional. Defaults to `gpt-5-nano` inside the api-server.                                                                                                                                                                                                                                                                                                                  |

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
run dev` against the same database from your host.

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

| What                 | Where                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------- |
| api-server logs      | `docker compose logs app` (or `docker logs <container>`)                                      |
| Postgres logs        | `docker compose logs db`                                                                      |
| Postgres data        | named volume `vulnrap_pgdata` (managed by Docker; see `docker volume inspect vulnrap_pgdata`) |
| Healthcheck endpoint | `GET /api/healthz` — returns 200 with `{"status":"ok"}` once boot finishes                    |

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

## 7. Upgrading & Database Migrations

VulnRap uses [Drizzle](https://orm.drizzle.team/) for schema management with a
**versioned, file-based migration set** that lives under `lib/db/drizzle/`.

```bash
git pull
docker compose build --pull            # rebuild against the latest base image
docker compose up -d
```

The api-server applies any new additive migrations on the next boot automatically
(`runStartupMigrations()` in `artifacts/api-server/src/lib/startup-migrations.ts`).
There is no separate "migrate then start" step required in the container.

If the migrator fails when `NODE_ENV=production`, the api-server **refuses
to start** rather than serve traffic against an unknown schema state.
Inspect the error in your logs, run `pnpm --filter @workspace/db run migrate`
manually to confirm the failure, fix the underlying issue, and restart. If
you genuinely want the legacy "log the error and serve anyway" behaviour
(e.g. you apply migrations through a separate pipeline and the boot-time
runner is just a safety net), set `IGNORE_MIGRATION_FAILURES=1`.

This is the recommended flow for single-instance deployments and is what the
hosted Replit deployment uses.

#### Upgrading from a pre-#723 install (baseline adoption)

If your installation predates task #723 — i.e. you have been running on
the older `drizzle-kit push` + boot-time additive-DDL flow — your
database already has every table the new migration set would create,
but `drizzle.__drizzle_migrations` does not exist yet. The migrator
handles this automatically: on the first run against a non-empty
schema with an empty journal, it stamps the journal as if every
existing migration had already been applied (a "baseline adoption"
step) and then starts running new migrations going forward. You do
not need to do anything special — `pnpm migrate` (or the boot-time
runner) is safe to run against your existing database on the first
upgrade.

### Option B — explicit `pnpm migrate` in your deploy pipeline

If you run multiple replicas or want migrations to be a separate, observable
deploy step, set `RUN_STARTUP_MIGRATIONS=0` in the api-server's environment
and run the migrator yourself before restarting the app:

```bash
# from the repo root, with DATABASE_URL pointed at your production DB
pnpm --filter @workspace/db run migrate
```

If a release ever requires destructive schema work, the release notes will say so
explicitly.

### Modifying the schema (Contributors)

Schema changes are **never** applied with `drizzle-kit push` against
production — `push` diffs the schema files against the live database and
applies the result with no review step, which can drop columns or wipe data.
The `push` script in `lib/db/package.json` enforces this with a guard that
refuses to run when `NODE_ENV=production`.

The flow for a schema change is:

```bash
# 1. Edit lib/db/src/schema/<file>.ts in your branch.

# 2. Generate a versioned migration from the schema diff. This writes a
#    new lib/db/drizzle/NNNN_<name>.sql plus an updated meta/ snapshot.
pnpm --filter @workspace/db run generate

# 3. Review the generated SQL. Edit it if drizzle-kit chose a destructive
#    plan (e.g. column rename emitted as drop + add) — drizzle-kit will
#    happily apply hand-edited migrations as long as you keep the snapshot
#    chain consistent. Run `pnpm --filter @workspace/db run check` to
#    verify the chain.
$EDITOR lib/db/drizzle/NNNN_*.sql

# 4. Commit the SQL file AND the meta/_journal.json + meta/NNNN_snapshot.json
#    updates together. The CI migration test re-applies every file from
#    empty on every PR; if the SQL doesn't match the schema files the
#    test will fail loudly.
git add lib/db/drizzle/
git commit -m "db: <describe the change>"
```

For local development you can still iterate quickly with
`pnpm --filter @workspace/db run push` (or `push:dev`), which bypasses the
versioned flow and applies the schema diff directly. **This is local dev
only — never run it against production.** Once you are happy with the
schema in your branch, generate the versioned migration as above before
opening the PR.

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

> The reason `.env`'s `DATABASE_URL` is _not_ threaded through to the
> `app` container is that the same file is also used for host-side `pnpm
dev`, where `localhost` is the right target. Threading it through
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

| Replit-only                                                                                   | Self-hosted equivalent                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.replit` workflows (`Project`, `artifacts/api-server: API Server`, `artifacts/vulnrap: web`) | `docker compose up` runs the same processes — there is one container instead of two workflows because the api-server serves the SPA static assets directly in production.                     |
| Replit-managed secrets                                                                        | Plain `.env` file consumed by `docker compose`.                                                                                                                                               |
| Replit Object Storage                                                                         | Not used by VulnRap today — the codebase persists everything in Postgres. If you fork to add file storage, swap in S3 / MinIO / a host volume.                                                |
| Replit Deploy autoscale                                                                       | Run multiple `app` replicas behind your proxy of choice and point them at the same Postgres.                                                                                                  |
| Playwright-driven SPA prerender                                                               | The container builds the SPA with `build:no-prerender` to keep the image small (no chromium binary). The SPA is fully functional client-side; prerendering is a hosted-only SEO optimisation. |

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

## Migration test in CI

Every PR runs `pnpm --filter @workspace/db run test`, which:

1. Provisions an empty Postgres (the `services.postgres` block in
   `.github/workflows/ci.yml`).
2. Applies every migration in `lib/db/drizzle/` from scratch.
3. Asserts a representative table from each migration file exists, the
   `is_holdout` column on `user_feedback` is in place, and the expression-
   based unique index `uniq_report_rescore_log_daily` was created.
4. Re-applies every migration and asserts the second pass is a no-op
   (column counts unchanged; the journal still has exactly one row per
   migration file).
5. Runs `drizzle-kit check` to confirm the journal/snapshot chain is
   consistent.

A migration that doesn't match the schema files, a hand-edited SQL file
with a stale snapshot, or a migration that fails to be idempotent will
fail this test on the PR.

---

Questions, bugs, or improvements: open an issue at
<https://github.com/REMEDiSSecurity/VulnRap.Com/issues>.
