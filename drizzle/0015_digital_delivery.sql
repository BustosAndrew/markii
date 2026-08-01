CREATE TABLE "digital_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"site_id" integer,
	"storage_path" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "download_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"grant_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"bytes" integer NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "download_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"order_id" integer NOT NULL,
	"order_line_id" integer,
	"asset_id" integer NOT NULL,
	"customer_id" integer,
	"email" text,
	"download_limit" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "licence_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_id" integer NOT NULL,
	"variant_id" integer,
	"key" text NOT NULL,
	"order_id" integer,
	"order_line_id" integer,
	"customer_id" integer,
	"assigned_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_digital_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"variant_id" integer,
	"asset_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "download_limit" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "download_expiry_days" integer;--> statement-breakpoint
ALTER TABLE "digital_assets" ADD CONSTRAINT "digital_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_assets" ADD CONSTRAINT "digital_assets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_grant_id_download_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."download_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_asset_id_digital_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."digital_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_keys" ADD CONSTRAINT "licence_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_keys" ADD CONSTRAINT "licence_keys_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_keys" ADD CONSTRAINT "licence_keys_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_keys" ADD CONSTRAINT "licence_keys_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_keys" ADD CONSTRAINT "licence_keys_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licence_keys" ADD CONSTRAINT "licence_keys_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_digital_assets" ADD CONSTRAINT "product_digital_assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_digital_assets" ADD CONSTRAINT "product_digital_assets_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_digital_assets" ADD CONSTRAINT "product_digital_assets_asset_id_digital_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."digital_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "digital_assets_org_idx" ON "digital_assets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "digital_assets_site_idx" ON "digital_assets" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_assets_path_uq" ON "digital_assets" USING btree ("storage_path");--> statement-breakpoint
CREATE INDEX "download_events_grant_idx" ON "download_events" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "download_events_org_created_idx" ON "download_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "download_grants_token_uq" ON "download_grants" USING btree ("token");--> statement-breakpoint
CREATE INDEX "download_grants_order_idx" ON "download_grants" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "download_grants_asset_idx" ON "download_grants" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "download_grants_customer_idx" ON "download_grants" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "licence_keys_product_idx" ON "licence_keys" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "licence_keys_order_idx" ON "licence_keys" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "licence_keys_pool_idx" ON "licence_keys" USING btree ("product_id","assigned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "licence_keys_org_key_uq" ON "licence_keys" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "product_digital_assets_product_idx" ON "product_digital_assets" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_digital_assets_asset_idx" ON "product_digital_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_digital_assets_uq" ON "product_digital_assets" USING btree ("product_id","variant_id","asset_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Quantity and size discipline at the database, not only in zod.
-- ---------------------------------------------------------------------------

-- A zero-byte asset is a failed upload that would deliver an empty file to a
-- paying buyer, and a negative one would credit the G5 storage meter.
ALTER TABLE "digital_assets" ADD CONSTRAINT "digital_assets_size_positive" CHECK ("size_bytes" > 0);--> statement-breakpoint
-- A limit of zero is a grant nobody can ever redeem — almost certainly meant as
-- "unlimited", which is NULL. Refusing it is better than selling a file that
-- cannot be downloaded once.
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_limit_positive" CHECK ("download_limit" IS NULL OR "download_limit" > 0);--> statement-breakpoint
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_count_non_negative" CHECK ("download_count" >= 0);--> statement-breakpoint
-- The database half of the download cap. The application checks it under a row
-- lock; this is what holds if two redemptions ever race past that check.
ALTER TABLE "download_grants" ADD CONSTRAINT "download_grants_within_limit" CHECK ("download_limit" IS NULL OR "download_count" <= "download_limit");--> statement-breakpoint
ALTER TABLE "download_events" ADD CONSTRAINT "download_events_bytes_non_negative" CHECK ("bytes" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_download_limit_positive" CHECK ("download_limit" IS NULL OR "download_limit" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_download_expiry_positive" CHECK ("download_expiry_days" IS NULL OR "download_expiry_days" > 0);--> statement-breakpoint

-- Deny by default (D6).
ALTER TABLE "digital_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_digital_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "download_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "download_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "licence_keys" ENABLE ROW LEVEL SECURITY;
