CREATE TABLE "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"identity_hash" varchar(64) NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" varchar(256) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_prefs_identity_key" ON "user_preferences" USING btree ("identity_hash","key");