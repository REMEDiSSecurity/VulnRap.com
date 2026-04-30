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

app.listen(port, (err) => {
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
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info(
        { signal },
        "Shutting down: stopping drift + rescore schedulers.",
      );
      driftScheduler.stop();
      stalledSchedulerWatchdog.stop();
      rescoreScheduler.stop();
    });
  }
});
