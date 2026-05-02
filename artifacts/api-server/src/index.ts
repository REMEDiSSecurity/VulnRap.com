import { pool } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { runStartupMigrations } from "./lib/startup-migrations";
import {
  startDriftNotificationScheduler,
  startStalledSchedulerWatchdog,
} from "./lib/avri-drift-notifications";
import { startRescoreBackfillScheduler } from "./lib/rescore-backfill-scheduler";

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

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Task #197 — Kick off the AVRI drift-notification scheduler. It runs at a
  // deterministic interval (default 6h, configurable via
  // AVRI_DRIFT_NOTIFY_INTERVAL_MS) and short-circuits when
  // AVRI_DRIFT_WEBHOOK_URL is unset, so unconfigured environments pay zero
  // cost per tick. Replaces the throttled fire-and-forget side effect that
  // POST /api/reports used to invoke. The handle is retained so signal
  // handlers can stop the timer cleanly during a graceful shutdown.
  const driftScheduler = startDriftNotificationScheduler();

  // Task #396 — Independent watchdog that periodically reads the drift
  // scheduler status and dispatches a one-off "scheduler appears wedged"
  // webhook when the next scheduled tick is significantly overdue
  // (Date.now() > nextTickAt + 2 * intervalMs). Independent of the main
  // scheduler timer so a wedged scheduler can't suppress its own alarm.
  // Dedup state lives in the same JSON file as drift flags, so a process
  // restart never re-pages reviewers for a stall window that was already
  // announced.
  const stalledSchedulerWatchdog = startStalledSchedulerWatchdog();

  // Task #388 — Kick off the recurring rescore backfill. The scheduler
  // is opt-in via RESCORE_BACKFILL_SCHEDULER_ENABLED so dev / test
  // environments don't accidentally rescore data; in production it
  // runs weekly (default) with a per-tick row cap and wall-clock
  // budget so a runaway scan can't saturate the DB. The handle is
  // retained so signal handlers can stop the timer cleanly during a
  // graceful shutdown.
  const rescoreScheduler = startRescoreBackfillScheduler();
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
  const SHUTDOWN_TIMEOUT_MS = process.env.NODE_ENV === "production" ? 5_000 : 50;
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
    server.close();
    server.closeAllConnections?.();
    // Fire-and-forget the pool drain — process.exit below will tear down
    // any remaining sockets if the drain doesn't complete first.
    pool.end().catch((err: unknown) => {
      logger.warn({ err }, "Error draining pg pool during shutdown");
    });
    // Hard deadline for exiting. We do NOT unref this timer: if some
    // module (e.g. pino-pretty's worker thread) keeps the event loop
    // alive past the natural drain, this still fires and force-exits.
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
