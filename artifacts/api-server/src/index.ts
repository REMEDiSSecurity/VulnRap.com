// Task #724 — Initialise OpenTelemetry FIRST, before any other application
// import, so the auto-instrumentations can patch http / express / pg before
// they are required. The init is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is
// unset, so unconfigured environments pay zero cost.
//
// Every dependency that transitively pulls `http` / `express` / `pg` is
// loaded via dynamic `import()` AFTER `initTracing()` resolves. Static ESM
// imports are evaluated before the module body runs, so a static
// `import { pool } from "@workspace/db"` would defeat instrumentation by
// loading `pg` before the SDK has had a chance to patch it.
import { initTracing } from "./lib/instrumentation";
await initTracing();

const { pool } = await import("@workspace/db");
const { default: app } = await import("./app");
const { logger } = await import("./lib/logger");
const { runStartupMigrations } = await import("./lib/startup-migrations");
const {
  startDriftNotificationScheduler,
  startStalledSchedulerWatchdog,
} = await import("./lib/avri-drift-notifications");
const { startRescoreBackfillScheduler } = await import(
  "./lib/rescore-backfill-scheduler"
);
const { startScoreStabilityScheduler } = await import(
  "./lib/score-stability-scheduler"
);
const { startHoldoutDriftScheduler } = await import(
  "./lib/holdout-drift-scheduler"
);
const { startHealthHeartbeatScheduler } = await import(
  "./lib/health-heartbeat-scheduler"
);
const { startPgPoolCollector, stopPgPoolCollector } = await import(
  "./lib/metrics"
);

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await runStartupMigrations();

// Task #724 — Begin sampling pg pool gauges (idle/total/waiting) every 5s.
startPgPoolCollector();

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const driftScheduler = startDriftNotificationScheduler();
  const stalledSchedulerWatchdog = startStalledSchedulerWatchdog();
  const rescoreScheduler = startRescoreBackfillScheduler();
  const stabilityScheduler = startScoreStabilityScheduler();
  const holdoutDriftScheduler = startHoldoutDriftScheduler();
  const healthHeartbeatScheduler = startHealthHeartbeatScheduler();
  // Task #462 — Graceful shutdown that actually exits.
  //
  // Without an explicit process.exit, the pino-pretty transport's worker
  // thread keeps the event loop alive even after schedulers are stopped,
  // the HTTP listener is closed, and the pg pool is drained. That meant
  // every dev restart had to wait for the watcher's SIGKILL grace window
  // before respawning. Fast-exit also benefits production: deploy / pod
  // evictions get a clean shutdown instead of a force-kill mid-request.
  //
  // Order:
  //   1. Stop schedulers (cancels their unref'd timers immediately).
  //   2. Stop accepting new connections (server.close) and forcibly
  //      drop idle keep-alive sockets (closeAllConnections) so the
  //      listener doesn't wait on lingering clients.
  //   3. Drain the pg pool.
  //   4. Exit cleanly. A short safety timeout force-exits if any of the
  //      above hangs, so a stuck pool drain can never block the dev
  //      watcher's respawn. The timeout is small in dev (we want a fast
  //      restart loop and the OS will reclaim sockets / DB connections)
  //      and longer in prod (give in-flight requests a chance to finish
  //      before the process dies).
  const SHUTDOWN_TIMEOUT_MS =
    process.env.NODE_ENV === "production" ? 5_000 : 50;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { signal },
      "Shutting down: stopping schedulers, closing listener, draining pool.",
    );
    driftScheduler.stop();
    stalledSchedulerWatchdog.stop();
    rescoreScheduler.stop();
    stabilityScheduler.stop();
    holdoutDriftScheduler.stop();
    healthHeartbeatScheduler.stop();
    stopPgPoolCollector();
    server.close();
    server.closeAllConnections?.();
    pool.end().catch((err: unknown) => {
      logger.warn({ err }, "Error draining pg pool during shutdown");
    });
    setTimeout(() => {
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
});
