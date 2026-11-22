CREATE TABLE "site_redirects" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"from_path" text NOT NULL,
	"to_url" text NOT NULL,
	"permanent" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_redirects" ADD CONSTRAINT "site_redirects_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_redirects_site_from_uq" ON "site_redirects" USING btree ("site_id","from_path");

-- Deny-by-default, like every table: authorization lives in the action registry.
ALTER TABLE "site_redirects" ENABLE ROW LEVEL SECURITY;
