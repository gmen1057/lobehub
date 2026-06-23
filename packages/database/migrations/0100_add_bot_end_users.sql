CREATE TABLE "bot_end_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_provider_id" uuid NOT NULL,
	"platform" varchar(50) NOT NULL,
	"end_user_id" varchar(255) NOT NULL,
	"end_user_username" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"quota_messages" integer,
	"messages_used" integer DEFAULT 0 NOT NULL,
	"quota_spent_rub" numeric(12, 4) DEFAULT '0' NOT NULL,
	"period_resets_at" timestamp with time zone,
	"granted_via" varchar(20) DEFAULT 'auto' NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_end_users" ADD CONSTRAINT "bot_end_users_bot_provider_id_agent_bot_providers_id_fk" FOREIGN KEY ("bot_provider_id") REFERENCES "public"."agent_bot_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_end_users_provider_end_user_unique" ON "bot_end_users" USING btree ("bot_provider_id","end_user_id");--> statement-breakpoint
CREATE INDEX "bot_end_users_provider_idx" ON "bot_end_users" USING btree ("bot_provider_id");--> statement-breakpoint
CREATE INDEX "bot_end_users_provider_status_idx" ON "bot_end_users" USING btree ("bot_provider_id","status");