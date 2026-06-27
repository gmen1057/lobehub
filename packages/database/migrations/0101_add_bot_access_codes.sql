CREATE TABLE IF NOT EXISTS "bot_access_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_provider_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"status_on_grant" varchar(20) DEFAULT 'active' NOT NULL,
	"quota_messages" integer,
	"consumed_at" timestamp with time zone,
	"consumed_by" varchar(255),
	"created_via" varchar(20) DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint

ALTER TABLE "bot_access_codes" ADD CONSTRAINT "bot_access_codes_bot_provider_id_agent_bot_providers_id_fk"
	FOREIGN KEY ("bot_provider_id") REFERENCES "agent_bot_providers"("id") ON DELETE CASCADE;

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "bot_access_codes_provider_code_unique"
	ON "bot_access_codes" ("bot_provider_id", "code");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bot_access_codes_provider_consumed_idx"
	ON "bot_access_codes" ("bot_provider_id", "consumed_at");
