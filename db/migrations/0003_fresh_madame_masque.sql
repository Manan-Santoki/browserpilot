CREATE TYPE "public"."link_state" AS ENUM('none', 'linked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('agent', 'login');--> statement-breakpoint
ALTER TABLE "site_accounts" ALTER COLUMN "target_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "site_accounts" ALTER COLUMN "target_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "site_accounts" ALTER COLUMN "target_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "site_accounts" ALTER COLUMN "target_role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD COLUMN "kind" "session_kind" DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_accounts" ADD COLUMN "link_state" "link_state" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_accounts" ADD COLUMN "linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_accounts" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_profiles" ADD COLUMN "logged_out_pattern" text;