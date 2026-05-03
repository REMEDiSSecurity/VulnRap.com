-- Task #733 — Welcome email + unsubscribe / confirm flow.
--
-- Adds two columns to `newsletter_subscriptions`:
--
--   * `confirmed_at` — wall-clock when the subscription was confirmed.
--     Backfilled to `created_at` for every legacy row so existing
--     subscribers are grandfathered as confirmed when the optional
--     NEWSLETTER_DOUBLE_OPT_IN flag is later turned on. New rows leave
--     it NULL when double opt-in is required and stamp it to NOW()
--     immediately when single opt-in is in effect (the default).
--
--   * `token_hash` — SHA-256 of an opaque token handed out exactly
--     once via the welcome / confirm email. Stored hashed so a DB
--     compromise cannot be replayed against /api/newsletter/confirm
--     or /api/newsletter/unsubscribe. The unique index is partial
--     (`WHERE token_hash IS NOT NULL`) so legacy rows that pre-date
--     this migration coexist without colliding on a NULL value.

ALTER TABLE "newsletter_subscriptions"
  ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "newsletter_subscriptions"
  ADD COLUMN IF NOT EXISTS "token_hash" varchar(64);
--> statement-breakpoint

UPDATE "newsletter_subscriptions"
  SET "confirmed_at" = "created_at"
  WHERE "confirmed_at" IS NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_newsletter_subscriptions_token_hash"
  ON "newsletter_subscriptions" ("token_hash")
  WHERE "token_hash" IS NOT NULL;
