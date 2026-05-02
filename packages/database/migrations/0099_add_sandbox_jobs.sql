CREATE TABLE IF NOT EXISTS "sandbox_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"parent_message_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"identifier" text NOT NULL,
	"api_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"sandbox_session_id" text,
	"result_payload" jsonb,
	"error_payload" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"locked_until" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"claim_attempts" integer DEFAULT 0 NOT NULL,
	"continuation_message_id" text,
	"continuation_claimed_by" text,
	"continuation_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 minutes' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_jobs" DROP CONSTRAINT IF EXISTS "sandbox_jobs_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD CONSTRAINT "sandbox_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_jobs" DROP CONSTRAINT IF EXISTS "sandbox_jobs_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD CONSTRAINT "sandbox_jobs_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_jobs_tool_call_id_unique" ON "sandbox_jobs" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_jobs_user_state_idx" ON "sandbox_jobs" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_jobs_state_created_active_idx" ON "sandbox_jobs" USING btree ("state","created_at") WHERE "sandbox_jobs"."state" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sandbox_jobs_topic_id_idx" ON "sandbox_jobs" USING btree ("topic_id");