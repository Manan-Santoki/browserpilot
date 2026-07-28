CREATE TABLE "site_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_profile_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"target_user_id" text NOT NULL,
	"target_email" text NOT NULL,
	"target_name" text NOT NULL,
	"target_role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_accounts" ADD CONSTRAINT "site_accounts_site_profile_id_site_profiles_id_fk" FOREIGN KEY ("site_profile_id") REFERENCES "public"."site_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_accounts" ADD CONSTRAINT "site_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_accounts_site_user_key" ON "site_accounts" USING btree ("site_profile_id","user_id");