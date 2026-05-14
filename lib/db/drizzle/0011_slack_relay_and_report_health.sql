-- Slack hosted-relay tenant table + report-health lifecycle columns.
--
-- Two unrelated additions in one migration so the deploy gate sees a
-- single new file. Both halves are additive and idempotent — re-running
-- this migration on a database that already contains either half is a
-- no-op (every CREATE / ALTER carries IF NOT EXISTS guards).
--
-- 1. slack_tenants: holds per-workspace install records for the hosted
--    "Add to Slack" relay. Bot token is encrypted at rest with
--    AES-256-GCM via SLACK_RELAY_MASTER_KEY (see
--    artifacts/api-server/src/lib/slack-token-crypto.ts). Notify URL
--    secret stored as sha256 hash + last 4 chars (UX only).
--
-- 2. reports.health_*: lifecycle tracking for failed / retry-pending /
--    abandoned reports. Default 'ok' so every existing row remains
--    healthy after the additive ALTER. The partial index on
--    (created_at WHERE health_status <> 'ok') stays cheap because the
--    indexed subset is tiny — the retry endpoint and the prune
--    scheduler are the only readers, and both filter on the unhealthy
--    status before paginating by created_at.

-- gen_random_uuid() ships in core on PG 13+. Replit-provisioned
-- Postgres is 16+; self-hosters on older majors must enable pgcrypto
-- themselves (CREATE EXTENSION here historically races against
-- concurrent migrate calls on first boot, so we leave it out).
CREATE TABLE IF NOT EXISTS "slack_tenants" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "team_id" text NOT NULL,
    "team_name" text NOT NULL,
    "channel_id" text NOT NULL,
    "channel_name" text NOT NULL,
    "bot_user_id" text NOT NULL,
    "bot_token_ciphertext" text NOT NULL,
    "bot_token_nonce" text NOT NULL,
    "bot_token_tag" text NOT NULL,
    "key_version" integer NOT NULL DEFAULT 1,
    "notify_token_hash" text NOT NULL,
    "notify_token_last4" varchar(8) NOT NULL,
    "status" varchar(20) NOT NULL DEFAULT 'active',
    "disabled_reason" text,
    "rate_limited_until" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "last_used_at" timestamp with time zone,
    "disabled_at" timestamp with time zone,
    CONSTRAINT "slack_tenants_notify_token_hash_unique" UNIQUE("notify_token_hash")
);

CREATE INDEX IF NOT EXISTS "slack_tenants_team_idx" ON "slack_tenants" ("team_id");
CREATE INDEX IF NOT EXISTS "slack_tenants_status_idx" ON "slack_tenants" ("status");

ALTER TABLE "reports"
    ADD COLUMN IF NOT EXISTS "health_status" varchar(20) NOT NULL DEFAULT 'ok';
ALTER TABLE "reports"
    ADD COLUMN IF NOT EXISTS "health_failure_class" varchar(40);
ALTER TABLE "reports"
    ADD COLUMN IF NOT EXISTS "health_failure_reason" text;
ALTER TABLE "reports"
    ADD COLUMN IF NOT EXISTS "health_retry_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "reports"
    ADD COLUMN IF NOT EXISTS "health_last_retry_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_reports_health_unhealthy"
    ON "reports" ("created_at")
    WHERE "health_status" <> 'ok';
