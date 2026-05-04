-- Task #1113 — Track welcome email delivery status.
--
-- Adds two columns to `newsletter_subscriptions`:
--
--   * `welcome_sent_at` — wall-clock timestamp when the welcome / confirm
--     email was successfully dispatched (HTTP 2xx from the delivery
--     webhook). NULL means either the row is brand-new (the async
--     dispatch hasn't resolved yet) or every delivery attempt has failed.
--
--   * `welcome_last_error` — the most-recent error string when the
--     delivery webhook returned non-2xx or threw. Cleared to NULL on a
--     successful send, so a non-NULL value always means "last attempt
--     failed". Capped at 500 characters.
--
-- No backfill is applied: pre-existing rows are left with both columns
-- NULL. The internal /internal/newsletter-delivery endpoint treats
-- old rows (created_at < NOW() - 5 minutes) with welcome_sent_at IS NULL
-- as "overdue" and surfaces them in the failure count.

ALTER TABLE "newsletter_subscriptions"
  ADD COLUMN IF NOT EXISTS "welcome_sent_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "newsletter_subscriptions"
  ADD COLUMN IF NOT EXISTS "welcome_last_error" varchar(500);
