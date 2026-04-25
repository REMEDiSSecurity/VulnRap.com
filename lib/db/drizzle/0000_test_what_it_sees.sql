CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"delete_token" varchar(64) DEFAULT '' NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"simhash" varchar(128) NOT NULL,
	"minhash_signature" jsonb NOT NULL,
	"lsh_buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_text" text,
	"redacted_text" text,
	"content_mode" varchar(20) DEFAULT 'full' NOT NULL,
	"slop_score" integer DEFAULT 0 NOT NULL,
	"slop_tier" varchar(30) DEFAULT 'Unknown' NOT NULL,
	"quality_score" integer DEFAULT 50 NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"breakdown" jsonb DEFAULT '{"linguistic":0,"factual":0,"template":0,"llm":null,"quality":50}'::jsonb,
	"evidence" jsonb DEFAULT '[]'::jsonb,
	"similarity_matches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"section_hashes" jsonb DEFAULT '{}'::jsonb,
	"section_matches" jsonb DEFAULT '[]'::jsonb,
	"redaction_summary" jsonb DEFAULT '{"totalRedactions":0,"categories":{}}'::jsonb,
	"feedback" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"llm_slop_score" integer,
	"llm_feedback" jsonb,
	"llm_breakdown" jsonb,
	"authenticity_score" integer DEFAULT 0 NOT NULL,
	"validity_score" integer DEFAULT 0 NOT NULL,
	"quadrant" varchar(30) DEFAULT 'WEAK_HUMAN' NOT NULL,
	"archetype" varchar(30) DEFAULT 'REQUEST_DETAILS' NOT NULL,
	"human_indicators" jsonb DEFAULT '[]'::jsonb,
	"template_hash" varchar(64),
	"vulnrap_composite_score" integer,
	"vulnrap_composite_label" varchar(32),
	"vulnrap_engine_results" jsonb,
	"vulnrap_overrides_applied" jsonb,
	"vulnrap_correlation_id" varchar(64),
	"vulnrap_duration_ms" real,
	"avri_family" varchar(32),
	"show_in_feed" boolean DEFAULT false NOT NULL,
	"file_name" varchar(255),
	"file_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_hashes" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"hash_type" varchar(20) NOT NULL,
	"hash_value" varchar(256) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "similarity_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_report_id" integer NOT NULL,
	"matched_report_id" integer NOT NULL,
	"similarity_score" real NOT NULL,
	"match_type" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_stats" (
	"key" varchar(50) PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer,
	"rating" integer NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"cache_key" varchar(512) NOT NULL,
	"response_data" jsonb NOT NULL,
	"ttl_category" varchar(20) DEFAULT 'mutable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_cache_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE TABLE "analysis_traces" (
	"id" serial PRIMARY KEY NOT NULL,
	"correlation_id" varchar(64) NOT NULL,
	"report_id" integer,
	"total_duration_ms" real NOT NULL,
	"trace" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_hashes" ADD CONSTRAINT "report_hashes_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "similarity_results" ADD CONSTRAINT "similarity_results_source_report_id_reports_id_fk" FOREIGN KEY ("source_report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "similarity_results" ADD CONSTRAINT "similarity_results_matched_report_id_reports_id_fk" FOREIGN KEY ("matched_report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reports_content_hash" ON "reports" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_reports_simhash" ON "reports" USING btree ("simhash");--> statement-breakpoint
CREATE INDEX "idx_reports_created_at" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_show_in_feed" ON "reports" USING btree ("show_in_feed","created_at");--> statement-breakpoint
CREATE INDEX "idx_reports_slop_score" ON "reports" USING btree ("slop_score");--> statement-breakpoint
CREATE INDEX "idx_reports_template_hash" ON "reports" USING btree ("template_hash");--> statement-breakpoint
CREATE INDEX "idx_reports_avri_family" ON "reports" USING btree ("avri_family");--> statement-breakpoint
CREATE INDEX "idx_reports_lsh_buckets" ON "reports" USING gin ("lsh_buckets");--> statement-breakpoint
CREATE INDEX "idx_report_hashes_hash_value" ON "report_hashes" USING btree ("hash_value");--> statement-breakpoint
CREATE INDEX "idx_report_hashes_report_id" ON "report_hashes" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_report_hashes_type_value" ON "report_hashes" USING btree ("hash_type","hash_value");--> statement-breakpoint
CREATE INDEX "idx_similarity_source" ON "similarity_results" USING btree ("source_report_id");--> statement-breakpoint
CREATE INDEX "idx_similarity_matched" ON "similarity_results" USING btree ("matched_report_id");--> statement-breakpoint
CREATE INDEX "idx_similarity_score" ON "similarity_results" USING btree ("similarity_score");--> statement-breakpoint
CREATE INDEX "idx_user_feedback_report_id" ON "user_feedback" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_api_cache_key" ON "api_cache" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "idx_api_cache_expires" ON "api_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_api_cache_category" ON "api_cache" USING btree ("ttl_category");--> statement-breakpoint
CREATE INDEX "idx_analysis_traces_correlation_id" ON "analysis_traces" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "idx_analysis_traces_report_id" ON "analysis_traces" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_analysis_traces_created_at" ON "analysis_traces" USING btree ("created_at");