CREATE TABLE "form_blocklist" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"pattern" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"form_id" integer,
	"form_handle" text NOT NULL,
	"form_name" text NOT NULL,
	"values" jsonb NOT NULL,
	"email" text,
	"notify_status" text NOT NULL,
	"notify_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"fields" jsonb NOT NULL,
	"submit_label" text DEFAULT 'Send' NOT NULL,
	"success_message" text DEFAULT '' NOT NULL,
	"notify_email" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_blocklist" ADD CONSTRAINT "form_blocklist_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_site_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."site_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_forms" ADD CONSTRAINT "site_forms_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_blocklist_site_pattern_uq" ON "form_blocklist" USING btree ("site_id","pattern");--> statement-breakpoint
CREATE INDEX "form_submissions_site_created_idx" ON "form_submissions" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "form_submissions_form_created_idx" ON "form_submissions" USING btree ("form_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_forms_site_handle_uq" ON "site_forms" USING btree ("site_id","handle");

-- Deny-by-default, like every table: authorization lives in the action registry.
ALTER TABLE "site_forms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "form_blocklist" ENABLE ROW LEVEL SECURITY;
