ALTER TABLE "robot_sessions" ADD COLUMN "resumed_from_session_id" uuid;--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD COLUMN "last_url" text;--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD COLUMN "last_user_message" text;--> statement-breakpoint
ALTER TABLE "robot_sessions" ADD CONSTRAINT "robot_sessions_resumed_from_session_id_robot_sessions_id_fk" FOREIGN KEY ("resumed_from_session_id") REFERENCES "public"."robot_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "robot_sessions_resumed_from_key" ON "robot_sessions" USING btree ("resumed_from_session_id");