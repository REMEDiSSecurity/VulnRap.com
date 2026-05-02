// Task #458 — Playwright globalSetup. Runs once before any spec executes.
//
// Two responsibilities:
//   1. Wait for the api-server's /api/healthz endpoint to come up. The
//      api-server runs `runStartupMigrations()` synchronously before
//      `app.listen(...)`, so a passing healthz means the schema is in
//      place and direct DB writes from this setup are safe.
//   2. Top up the labeled-corpus marker rows so the Task #325 production-
//      scan-limit spec's strict-increase branch is non-vacuous on a fresh
//      DB (>= 101 rows where vulnrap_composite_label IS NOT NULL AND
//      content_text IS NOT NULL).
//
// Note on Playwright execution order: globalSetup and the configured
// `webServer` blocks may run concurrently. We don't depend on either order
// — the healthz polling loop tolerates the api-server still booting and
// covers both `reuseExistingServer` (already running, healthz returns
// instantly) and cold-start (waits up to the same 240s timeout the
// webServer blocks themselves use).
//
// Opt-out: set E2E_SKIP_LABELED_CORPUS_SEED=1 to skip the seed entirely
// (e.g. when running a single non-Task-#325 spec against a known-good
// DB). The healthz wait still runs so fast-fail behavior on a missing
// api-server is unchanged.

import type { FullConfig } from "@playwright/test";
import { seedE2eLabeledCorpus } from "../../api-server/src/seed-e2e-labeled-corpus";

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const HEALTHZ_URL = `http://127.0.0.1:${API_PORT}/api/healthz`;
// Match the per-webServer timeout in playwright.config.ts so a slow cold
// start doesn't fall out from under us before the server itself has had
// its chance.
const HEALTHZ_TIMEOUT_MS = 240_000;
const HEALTHZ_POLL_INTERVAL_MS = 500;

async function waitForHealthz(): Promise<void> {
  const deadline = Date.now() + HEALTHZ_TIMEOUT_MS;
  let lastErr: string = "no attempt yet";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTHZ_URL);
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, HEALTHZ_POLL_INTERVAL_MS));
  }
  throw new Error(
    `[e2e global-setup] api-server health check at ${HEALTHZ_URL} did not pass within ${HEALTHZ_TIMEOUT_MS}ms (last attempt: ${lastErr})`,
  );
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.E2E_NO_WEBSERVER) {
    // External harness is responsible for both the api-server and seeding.
    // We still don't touch the DB — the caller may be pointing at a
    // production-shaped fixture they don't want polluted.
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[e2e global-setup] waiting for ${HEALTHZ_URL} ...`);
  await waitForHealthz();

  if (process.env.E2E_SKIP_LABELED_CORPUS_SEED === "1") {
    // eslint-disable-next-line no-console
    console.log(
      "[e2e global-setup] E2E_SKIP_LABELED_CORPUS_SEED=1 — skipping labeled corpus seed.",
    );
    return;
  }

  const start = Date.now();
  const result = await seedE2eLabeledCorpus();
  // eslint-disable-next-line no-console
  console.log(
    `[e2e global-setup] labeled corpus ready: existing=${result.existing} inserted=${result.inserted} total=${result.total} (${Date.now() - start}ms)`,
  );
}
