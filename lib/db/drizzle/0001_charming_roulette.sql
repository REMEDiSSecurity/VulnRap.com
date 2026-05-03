CREATE TABLE "newsletter_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_hmac" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_rescore_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"old_score" integer NOT NULL,
	"new_score" integer NOT NULL,
	"old_tier" varchar(30) NOT NULL,
	"new_tier" varchar(30) NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code_version" varchar(64) DEFAULT 'unknown' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phrase_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"text" varchar(240) NOT NULL,
	"category" varchar(32) NOT NULL,
	"context" text,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"ip_hmac" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "engine_versions" jsonb;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "fake_raw_http" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "stripped_crash_trace" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_rescore_log" ADD CONSTRAINT "report_rescore_log_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_newsletter_subscriptions_email_hmac" ON "newsletter_subscriptions" USING btree ("email_hmac");--> statement-breakpoint
CREATE INDEX "idx_newsletter_subscriptions_created_at" ON "newsletter_subscriptions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_report_rescore_log_scored_at" ON "report_rescore_log" USING btree ("scored_at");--> statement-breakpoint
CREATE INDEX "idx_report_rescore_log_report_id" ON "report_rescore_log" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_phrase_suggestions_status_created_at" ON "phrase_suggestions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_phrase_suggestions_ip_hmac_created_at" ON "phrase_suggestions" USING btree ("ip_hmac","created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_fake_raw_http" ON "reports" USING btree ("show_in_feed","created_at") WHERE "reports"."fake_raw_http" = true;--> statement-breakpoint
CREATE INDEX "idx_reports_stripped_crash_trace" ON "reports" USING btree ("show_in_feed","created_at") WHERE "reports"."stripped_crash_trace" = true;