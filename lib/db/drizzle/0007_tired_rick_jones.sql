CREATE TABLE "showcase_nominations" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"reason" text NOT NULL,
	"email" varchar(320),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"ip_hmac" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_showcase_nominations_status_created_at" ON "showcase_nominations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_showcase_nominations_ip_hmac_created_at" ON "showcase_nominations" USING btree ("ip_hmac","created_at");--> statement-breakpoint
CREATE INDEX "idx_showcase_nominations_report_id" ON "showcase_nominations" USING btree ("report_id");