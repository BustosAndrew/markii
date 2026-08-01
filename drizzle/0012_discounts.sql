CREATE TABLE "discount_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"discount_id" integer NOT NULL,
	"order_id" integer,
	"customer_id" integer,
	"amount_minor" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"code" text,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"percentage_bps" integer,
	"value_minor" integer,
	"applies_to_scope" text DEFAULT 'order' NOT NULL,
	"applies_to_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minimum_subtotal_minor" integer,
	"customer_eligibility" text DEFAULT 'all' NOT NULL,
	"eligible_customer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_limit" integer,
	"usage_limit_per_customer" integer,
	"combines_with_product" boolean DEFAULT false NOT NULL,
	"combines_with_order" boolean DEFAULT false NOT NULL,
	"combines_with_shipping" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_discount_id_discounts_id_fk" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discount_redemptions_discount_idx" ON "discount_redemptions" USING btree ("discount_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_customer_idx" ON "discount_redemptions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_discount_order_uq" ON "discount_redemptions" USING btree ("discount_id","order_id");--> statement-breakpoint
CREATE INDEX "discounts_site_idx" ON "discounts" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_site_code_uq" ON "discounts" USING btree ("site_id","code");--> statement-breakpoint
-- Money and rate discipline at the database, not only in zod. A negative value
-- or a >100% percentage is a discount that adds money to an order.
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_percentage_range" CHECK ("percentage_bps" IS NULL OR ("percentage_bps" >= 0 AND "percentage_bps" <= 10000));--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_value_non_negative" CHECK ("value_minor" IS NULL OR "value_minor" >= 0);--> statement-breakpoint
-- A discount whose window closes before it opens can never apply, and looks
-- configured until a shopper reports the code "not working".
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_window_ordered" CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "starts_at" <= "ends_at");--> statement-breakpoint
-- Deny by default (D6).
ALTER TABLE "discounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ENABLE ROW LEVEL SECURITY;
