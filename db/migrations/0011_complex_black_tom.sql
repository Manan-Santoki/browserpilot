ALTER TABLE "job_candidate_profiles" RENAME COLUMN "application_email" TO "application_email_encrypted";--> statement-breakpoint
ALTER TABLE "job_candidate_profiles" RENAME COLUMN "notification_email" TO "notification_email_encrypted";--> statement-breakpoint
DROP INDEX "job_applications_user_normalized_active_key";--> statement-breakpoint
ALTER TABLE "job_applications" ADD COLUMN "takeover_request_id" text;--> statement-breakpoint
ALTER TABLE "job_questions" ADD COLUMN "request_id" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_questions_request_key" ON "job_questions" USING btree ("application_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_applications_user_normalized_active_key" ON "job_applications" USING btree ("user_id","normalized_url") WHERE "job_applications"."status" in ('queued', 'running', 'needs_attention');