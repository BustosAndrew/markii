CREATE TABLE "agent_traffic" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"product_id" integer,
	"path" text NOT NULL,
	"agent_user_agent" text DEFAULT '' NOT NULL,
	"agent_name" text DEFAULT 'Other' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"parent_id" integer,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"image_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"provider" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer,
	"product_id" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USDC' NOT NULL,
	"provider" text DEFAULT 'x402' NOT NULL,
	"tx_hash" text,
	"agent_user_agent" text DEFAULT '' NOT NULL,
	"agent_name" text DEFAULT 'Other' NOT NULL,
	"agent_wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"category_id" integer,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"sku" text,
	"stock" integer DEFAULT 0 NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"suggested_product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"custom_domain" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"theme_id" text DEFAULT 'studio' NOT NULL,
	"indexed" boolean DEFAULT true NOT NULL,
	"agent_discovery" boolean DEFAULT true NOT NULL,
	"purchases_enabled" boolean DEFAULT true NOT NULL,
	"payment_providers" jsonb DEFAULT '{"x402":true,"stripe":false}'::jsonb NOT NULL,
	"wallet_address" text,
	"google_site_verification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_traffic" ADD CONSTRAINT "agent_traffic_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_traffic" ADD CONSTRAINT "agent_traffic_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "traffic_site_idx" ON "agent_traffic" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "traffic_created_idx" ON "agent_traffic" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_site_slug_uq" ON "categories" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX "categories_site_idx" ON "categories" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "orders_site_idx" ON "orders" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_site_slug_uq" ON "products" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX "products_site_idx" ON "products" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_slug_uq" ON "sites" USING btree ("slug");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Row Level Security: deny by default (D6, hand-authored — not generated).
--
-- Markii authorizes in the action registry (docs/API.md §22), NEVER in RLS —
-- two authorization systems that disagree is worse than either alone. This is
-- defence in depth only: enabling RLS with no policies means a leaked anon key
-- reads nothing.
--
-- Deliberately NOT `FORCE ROW LEVEL SECURITY`. The app connects as the table
-- owner, which RLS exempts; FORCE would revoke that exemption and, with zero
-- policies defined, every application query would return zero rows.
-- ---------------------------------------------------------------------------
ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_traffic" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Supabase grants the browser-facing roles table privileges by default. RLS
-- already blocks them; revoking as well means one accidental policy does not
-- silently open a table. Guarded so the migration still runs on a plain
-- Postgres, where these roles do not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
  END IF;
END $$;
