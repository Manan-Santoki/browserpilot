CREATE TYPE "public"."job_application_status" AS ENUM('queued', 'running', 'needs_attention', 'applied', 'not_applied', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_connection_kind" AS ENUM('gmail');--> statement-breakpoint
CREATE TYPE "public"."job_document_kind" AS ENUM('resume', 'cover_letter');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "job_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question_label" text NOT NULL,
	"answer_encrypted" text NOT NULL,
	"category" text DEFAULT 'custom' NOT NULL,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid,
	"resume_document_id" uuid,
	"cover_letter_document_id" uuid,
	"source_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"company" text,
	"role_title" text,
	"ats_kind" text DEFAULT 'generic' NOT NULL,
	"status" "job_application_status" DEFAULT 'queued' NOT NULL,
	"status_detail" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"model" text,
	"confirmation_url" text,
	"confirmation_text" text,
	"confirmation_reference" text,
	"confirmation_screenshot_key" text,
	"submitted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"resume_document_id" uuid,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_candidate_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"profile_encrypted" text NOT NULL,
	"application_email" text NOT NULL,
	"notification_email" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "job_connection_kind" NOT NULL,
	"account_email" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"version" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "job_document_kind" NOT NULL,
	"name" text NOT NULL,
	"filename" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source_application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_portal_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"portal_key" text NOT NULL,
	"portal_label" text NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"dedupe_key" text NOT NULL,
	"to_email" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD COLUMN "job_application_id" uuid;--> statement-breakpoint
ALTER TABLE "job_answers" ADD CONSTRAINT "job_answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_application_events" ADD CONSTRAINT "job_application_events_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."job_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_batch_id_job_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."job_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_resume_document_id_job_documents_id_fk" FOREIGN KEY ("resume_document_id") REFERENCES "public"."job_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_cover_letter_document_id_job_documents_id_fk" FOREIGN KEY ("cover_letter_document_id") REFERENCES "public"."job_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_batches" ADD CONSTRAINT "job_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_batches" ADD CONSTRAINT "job_batches_resume_document_id_job_documents_id_fk" FOREIGN KEY ("resume_document_id") REFERENCES "public"."job_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_candidate_profiles" ADD CONSTRAINT "job_candidate_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_connections" ADD CONSTRAINT "job_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_consents" ADD CONSTRAINT "job_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_documents" ADD CONSTRAINT "job_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_documents" ADD CONSTRAINT "job_documents_source_application_id_job_applications_id_fk" FOREIGN KEY ("source_application_id") REFERENCES "public"."job_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_portal_accounts" ADD CONSTRAINT "job_portal_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_application_id_job_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."job_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_answers_user_question_key" ON "job_answers" USING btree ("user_id","question_key");--> statement-breakpoint
CREATE INDEX "job_answers_user_id_idx" ON "job_answers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "job_application_events_application_idx" ON "job_application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "job_applications_user_status_idx" ON "job_applications" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "job_applications_batch_id_idx" ON "job_applications" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_applications_user_normalized_active_key" ON "job_applications" USING btree ("user_id","normalized_url") WHERE "job_applications"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "job_batches_user_id_idx" ON "job_batches" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_connections_user_kind_key" ON "job_connections" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "job_consents_user_version_key" ON "job_consents" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "job_documents_user_kind_idx" ON "job_documents" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "job_portal_accounts_user_portal_key" ON "job_portal_accounts" USING btree ("user_id","portal_key");--> statement-breakpoint
CREATE INDEX "job_portal_accounts_user_id_idx" ON "job_portal_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_dedupe_key" ON "notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD CONSTRAINT "robot_sessions_job_application_id_job_applications_id_fk" FOREIGN KEY ("job_application_id") REFERENCES "public"."job_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "robot_sessions_job_application_key" ON "robot_sessions" USING btree ("job_application_id");