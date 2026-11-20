CREATE TABLE "storefront_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"label" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by_user_id" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storefront_keys" ADD CONSTRAINT "storefront_keys_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_keys_hash_uq" ON "storefront_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "storefront_keys_site_idx" ON "storefront_keys" USING btree ("site_id");--> statement-breakpoint
-- Deny-by-default, like every table: authorization lives in the action registry.
ALTER TABLE "storefront_keys" ENABLE ROW LEVEL SECURITY;
