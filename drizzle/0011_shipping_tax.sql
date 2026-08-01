CREATE TABLE "shipping_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"zone_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"price_minor" integer DEFAULT 0 NOT NULL,
	"min_weight_grams" integer,
	"max_weight_grams" integer,
	"min_subtotal_minor" integer,
	"max_subtotal_minor" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipping_zones" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provinces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_settings" (
	"site_id" integer PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'none' NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"manual_rates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_tax_code" text,
	"registrations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_zone_id_shipping_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."shipping_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipping_zones" ADD CONSTRAINT "shipping_zones_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipping_rates_zone_idx" ON "shipping_rates" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "shipping_zones_site_idx" ON "shipping_zones" USING btree ("site_id");--> statement-breakpoint
-- A shipping price is money and follows the same discipline as every other
-- amount: non-negative integer minor units, enforced by the database rather than
-- only by zod. A negative rate would subtract from a checkout total.
ALTER TABLE "shipping_rates" ADD CONSTRAINT "shipping_rates_price_non_negative" CHECK ("price_minor" >= 0);--> statement-breakpoint
-- Deny by default (D6).
ALTER TABLE "shipping_zones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shipping_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_settings" ENABLE ROW LEVEL SECURITY;