CREATE TYPE "public"."job_connection_state" AS ENUM('active', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_portal_account_status" AS ENUM('pending', 'active', 'reset_required', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."job_question_status" AS ENUM('pending', 'answered', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."job_question_type" AS ENUM('text', 'boolean', 'number', 'date', 'single_choice', 'multi_choice');--> statement-breakpoint
CREATE TABLE "job_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_label" text NOT NULL,
	"answer_type" "job_question_type" NOT NULL,
	"options" jsonb,
	"option_signature" text NOT NULL,
	"status" "job_question_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "job_answers_user_question_key";--> statement-breakpoint
ALTER TABLE "job_answers" ADD COLUMN "answer_type" "job_question_type" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_answers" ADD COLUMN "option_signature" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "portal_key" text;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "external_job_id" text;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "attention_kind" text;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "reapply_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "duplicate_of_application_id" uuid;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "submission_inventory" jsonb;--> statement-breakpoint
ALTER TABLE "job_connections" ADD COLUMN "state" "job_connection_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_connections" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "job_connections" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_connections" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_documents" ADD COLUMN "encryption_aad" text NOT NULL;--> statement-breakpoint
ALTER TABLE "job_documents" ADD COLUMN "extracted_text_encrypted" text;--> statement-breakpoint
ALTER TABLE "job_portal_accounts" ADD COLUMN "portal_origin" text NOT NULL;--> statement-breakpoint
ALTER TABLE "job_portal_accounts" ADD COLUMN "status" "job_portal_account_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_portal_accounts" ADD COLUMN "verification_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_portal_accounts" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_questions" ADD CONSTRAINT "job_questions_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."job_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_questions" ADD CONSTRAINT "job_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_questions_user_status_idx" ON "job_questions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "job_questions_application_match_key" ON "job_questions" USING btree ("application_id","question_key","option_signature");--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_duplicate_of_application_id_job_applications_id_fk" FOREIGN KEY ("duplicate_of_application_id") REFERENCES "public"."job_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_applications_claim_idx" ON "job_applications" USING btree ("status","claim_expires_at");--> statement-breakpoint
CREATE INDEX "job_applications_portal_external_idx" ON "job_applications" USING btree ("user_id","portal_key","external_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_answers_user_question_key" ON "job_answers" USING btree ("user_id","question_key","option_signature");