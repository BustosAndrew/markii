CREATE TABLE "fulfillment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"fulfillment_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"status" text DEFAULT 'shipped' NOT NULL,
	"tracking_number" text,
	"carrier" text,
	"tracking_url" text,
	"notified_customer" boolean DEFAULT false NOT NULL,
	"note" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"invocation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"invocation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer,
	"variant_id" integer,
	"title" text NOT NULL,
	"variant_title" text,
	"sku" text,
	"quantity" integer NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quantity_refunded" integer DEFAULT 0 NOT NULL,
	"quantity_fulfilled" integer DEFAULT 0 NOT NULL,
	"location_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"refund_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer DEFAULT 0 NOT NULL,
	"restocked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"subtotal_minor" integer DEFAULT 0 NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer DEFAULT 0 NOT NULL,
	"shipping_minor" integer DEFAULT 0 NOT NULL,
	"amount_minor" integer NOT NULL,
	"net_sales_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"reason" text DEFAULT 'requested_by_customer' NOT NULL,
	"note" text,
	"restock" boolean DEFAULT true NOT NULL,
	"method" text DEFAULT 'manual' NOT NULL,
	"rail" text NOT NULL,
	"processor_reference" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"invocation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "line_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "financial_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_status" text DEFAULT 'unfulfilled' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
-- Added nullable, backfilled, then constrained. `ADD COLUMN ... NOT NULL` with
-- no default fails outright on a table that already has rows, and the generator
-- has no way to know what the backfill should be.
ALTER TABLE "usage_records" ADD COLUMN "dedupe_key" text;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

-- The key that `(order_id, type)` used to enforce, restated per event. Existing
-- rows are all sales, one per order, so this is the same uniqueness expressed in
-- a way that partial refunds no longer collide with.
UPDATE "usage_records" SET "dedupe_key" = "type" || ':' || coalesce("order_id"::text, "id")
  WHERE "dedupe_key" IS NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "dedupe_key" SET NOT NULL;--> statement-breakpoint
DROP INDEX "usage_records_order_type_uq";--> statement-breakpoint

-- Orders that came through a checkout session already have an authoritative
-- split; copy it rather than guess. Orders that predate §18.4 (the direct x402
-- path) were never quoted tax or shipping, so their total *is* their subtotal —
-- a fact about how those orders were created, not an assumption about them.
UPDATE "orders" o SET
  "subtotal_minor" = s."subtotal_minor",
  "discount_minor" = s."discount_minor",
  "tax_minor"      = s."tax_minor",
  "shipping_minor" = s."shipping_minor",
  "email"          = coalesce(o."email", s."email")
FROM "checkout_sessions" s
WHERE s."order_id" = o."id";--> statement-breakpoint

UPDATE "orders" o SET "subtotal_minor" = o."amount_cents"
WHERE o."subtotal_minor" = 0
  AND NOT EXISTS (SELECT 1 FROM "checkout_sessions" s WHERE s."order_id" = o."id");--> statement-breakpoint

-- `financial_status` is a new axis, not a rename: `status` keeps its v1 meaning
-- (the payment outcome) and every existing branch on 'success' keeps working.
UPDATE "orders" SET "financial_status" = CASE
  WHEN "status" = 'success' THEN 'paid'
  WHEN "status" = 'cancel'  THEN 'voided'
  ELSE 'pending' END;--> statement-breakpoint

ALTER TABLE "fulfillment_lines" ADD CONSTRAINT "fulfillment_lines_fulfillment_id_fulfillments_id_fk" FOREIGN KEY ("fulfillment_id") REFERENCES "public"."fulfillments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_lines" ADD CONSTRAINT "fulfillment_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillments" ADD CONSTRAINT "fulfillments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fulfillment_lines_fulfillment_idx" ON "fulfillment_lines" USING btree ("fulfillment_id");--> statement-breakpoint
CREATE INDEX "fulfillment_lines_order_line_idx" ON "fulfillment_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "fulfillments_order_idx" ON "fulfillments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_events_order_created_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_product_idx" ON "order_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "refund_lines_refund_idx" ON "refund_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refund_lines_order_line_idx" ON "refund_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_financial_status_idx" ON "orders" USING btree ("financial_status");--> statement-breakpoint
CREATE INDEX "orders_fulfillment_status_idx" ON "orders" USING btree ("fulfillment_status");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_dedupe_uq" ON "usage_records" USING btree ("dedupe_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Money and quantity discipline at the database, not only in zod.
--
-- Every one of these is reachable through the action registry today; they exist
-- because a refund that over-returns units or money is not a validation slip a
-- merchant can edit away afterwards.
-- ---------------------------------------------------------------------------

ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_quantity_positive" CHECK ("quantity" > 0);--> statement-breakpoint
-- Refunding more units than were sold would restock stock that never left and
-- return money the shopper never paid.
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_refunded_within_quantity" CHECK ("quantity_refunded" >= 0 AND "quantity_refunded" <= "quantity");--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_fulfilled_within_quantity" CHECK ("quantity_fulfilled" >= 0 AND "quantity_fulfilled" <= "quantity");--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_quantity_positive" CHECK ("quantity" > 0);--> statement-breakpoint
ALTER TABLE "fulfillment_lines" ADD CONSTRAINT "fulfillment_lines_quantity_positive" CHECK ("quantity" > 0);--> statement-breakpoint
-- A refund is money leaving; a negative one is money arriving — a sale recorded
-- through the wrong door, which would *credit* the threshold meter.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_non_negative" CHECK ("amount_minor" >= 0);--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_net_sales_non_negative" CHECK ("net_sales_minor" >= 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refunded_non_negative" CHECK ("refunded_minor" >= 0);--> statement-breakpoint

-- Deny by default (D6).
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "refund_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fulfillments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fulfillment_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_events" ENABLE ROW LEVEL SECURITY;