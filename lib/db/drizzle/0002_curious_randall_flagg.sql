CREATE TABLE "report_shadow_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"live_score" integer NOT NULL,
	"live_tier" varchar(30) NOT NULL,
	"shadow_score" integer NOT NULL,
	"shadow_tier" varchar(30) NOT NULL,
	"score_diff" integer NOT NULL,
	"tier_diverged" boolean DEFAULT false NOT NULL,
	"shadow_version" varchar(64) DEFAULT 'unknown' NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" varchar(200) NOT NULL,
	"method" varchar(10) NOT NULL,
	"endpoint" varchar(500) NOT NULL,
	"request_payload" jsonb,
	"query_params" jsonb,
	"response_status" integer NOT NULL,
	"ip" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" varchar(1000) NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"event_types" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD COLUMN "is_holdout" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_shadow_scores" ADD CONSTRAINT "report_shadow_scores_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_report_shadow_scores_scored_at" ON "report_shadow_scores" USING btree ("scored_at");--> statement-breakpoint
CREATE INDEX "idx_report_shadow_scores_report_id" ON "report_shadow_scores" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_report_shadow_scores_diverged" ON "report_shadow_scores" USING btree ("tier_diverged");--> statement-breakpoint
CREATE INDEX "idx_audit_log_created_at" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor" ON "audit_log" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "idx_audit_log_endpoint" ON "audit_log" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "idx_webhooks_created_at" ON "webhooks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_user_feedback_is_holdout" ON "user_feedback" USING btree ("is_holdout");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_report_rescore_log_daily" ON "report_rescore_log" (
  "report_id",
  "code_version",
  (("scored_at" AT TIME ZONE 'UTC')::date)
);--> statement-breakpoint
UPDATE "user_feedback"
   SET "is_holdout" = ((abs(hashtext("id"::text)) % 5) = 0)
 WHERE "is_holdout" <> ((abs(hashtext("id"::text)) % 5) = 0);
