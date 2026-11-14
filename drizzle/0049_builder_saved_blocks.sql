CREATE TABLE "site_saved_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"node" jsonb NOT NULL,
	"node_count" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_saved_blocks" ADD CONSTRAINT "site_saved_blocks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_saved_blocks_site_name_uq" ON "site_saved_blocks" USING btree ("site_id","name");--> statement-breakpoint

-- Deny-by-default, like every table: authorization lives in the action registry.
ALTER TABLE "site_saved_blocks" ENABLE ROW LEVEL SECURITY;
