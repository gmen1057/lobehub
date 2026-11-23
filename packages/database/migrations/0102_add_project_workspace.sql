CREATE TABLE IF NOT EXISTS "project_workspace_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" varchar(20) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"encoding" varchar(20),
	"line_ending" varchar(4),
	"load_mode" varchar(20) DEFAULT 'on_demand' NOT NULL,
	"load_priority" integer DEFAULT 100 NOT NULL,
	"is_protected" boolean DEFAULT false NOT NULL,
	"user_summary" varchar(120),
	"current_revision" integer DEFAULT 1 NOT NULL,
	"current_file_id" text NOT NULL,
	"current_document_id" varchar(255),
	"content_sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"char_count" integer,
	"line_count" integer,
	"rag_enabled" boolean DEFAULT false NOT NULL,
	"data_guard_status" varchar(20) DEFAULT 'unmasked' NOT NULL,
	"created_by" varchar(20) NOT NULL,
	"updated_by" varchar(20) NOT NULL,
	"last_topic_id" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_file_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_file_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"revision" integer NOT NULL,
	"file_id" text NOT NULL,
	"document_id" varchar(255),
	"content_sha256" varchar(64) NOT NULL,
	"byte_size" integer NOT NULL,
	"char_count" integer,
	"line_count" integer,
	"encoding" varchar(20),
	"line_ending" varchar(4),
	"author_type" varchar(20) NOT NULL,
	"topic_id" text,
	"message_id" text,
	"change_note" varchar(240),
	"diff_stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_file_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"workspace_file_id" uuid,
	"target_path" text NOT NULL,
	"proposal_type" varchar(20) NOT NULL,
	"base_revision" integer,
	"proposed_file_id" text,
	"reason" varchar(500),
	"diff_stats" jsonb,
	"diff_preview" text,
	"topic_id" text,
	"message_id" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_workspace_files" DROP CONSTRAINT IF EXISTS "project_workspace_files_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_workspace_files" ADD CONSTRAINT "project_workspace_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspace_files" DROP CONSTRAINT IF EXISTS "project_workspace_files_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "project_workspace_files" ADD CONSTRAINT "project_workspace_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspace_files" DROP CONSTRAINT IF EXISTS "project_workspace_files_current_file_id_files_id_fk";--> statement-breakpoint
ALTER TABLE "project_workspace_files" ADD CONSTRAINT "project_workspace_files_current_file_id_files_id_fk" FOREIGN KEY ("current_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspace_files" DROP CONSTRAINT IF EXISTS "project_workspace_files_current_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "project_workspace_files" ADD CONSTRAINT "project_workspace_files_current_document_id_documents_id_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workspace_files" DROP CONSTRAINT IF EXISTS "project_workspace_files_last_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "project_workspace_files" ADD CONSTRAINT "project_workspace_files_last_topic_id_topics_id_fk" FOREIGN KEY ("last_topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_revisions" DROP CONSTRAINT IF EXISTS "project_file_revisions_workspace_file_id_project_workspace_files_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_workspace_file_id_project_workspace_files_id_fk" FOREIGN KEY ("workspace_file_id") REFERENCES "public"."project_workspace_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_revisions" DROP CONSTRAINT IF EXISTS "project_file_revisions_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_revisions" DROP CONSTRAINT IF EXISTS "project_file_revisions_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_revisions" DROP CONSTRAINT IF EXISTS "project_file_revisions_file_id_files_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_revisions" DROP CONSTRAINT IF EXISTS "project_file_revisions_document_id_documents_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_revisions" DROP CONSTRAINT IF EXISTS "project_file_revisions_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_proposals" DROP CONSTRAINT IF EXISTS "project_file_proposals_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_proposals" ADD CONSTRAINT "project_file_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_proposals" DROP CONSTRAINT IF EXISTS "project_file_proposals_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_proposals" ADD CONSTRAINT "project_file_proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_proposals" DROP CONSTRAINT IF EXISTS "project_file_proposals_workspace_file_id_project_workspace_files_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_proposals" ADD CONSTRAINT "project_file_proposals_workspace_file_id_project_workspace_files_id_fk" FOREIGN KEY ("workspace_file_id") REFERENCES "public"."project_workspace_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_proposals" DROP CONSTRAINT IF EXISTS "project_file_proposals_proposed_file_id_files_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_proposals" ADD CONSTRAINT "project_file_proposals_proposed_file_id_files_id_fk" FOREIGN KEY ("proposed_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_file_proposals" DROP CONSTRAINT IF EXISTS "project_file_proposals_topic_id_topics_id_fk";--> statement-breakpoint
ALTER TABLE "project_file_proposals" ADD CONSTRAINT "project_file_proposals_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pwf_agent_path" ON "project_workspace_files" ("agent_id", lower("path"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pwf_user_agent_active" ON "project_workspace_files" ("user_id", "agent_id", "load_mode", "updated_at" DESC) WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pwf_current_file_id" ON "project_workspace_files" ("current_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pfr_file_revision" ON "project_file_revisions" ("workspace_file_id", "revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pfr_file_id" ON "project_file_revisions" ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pfr_agent_id" ON "project_file_revisions" ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pfp_agent_status" ON "project_file_proposals" ("agent_id", "status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pfp_proposed_file_id" ON "project_file_proposals" ("proposed_file_id");
