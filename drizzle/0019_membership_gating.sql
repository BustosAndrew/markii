CREATE TABLE "customer_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"tier_id" integer NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"source" text NOT NULL,
	"order_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_tiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "requires_tier_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "grants_tier_id" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "grants_duration_days" integer;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_tier_id_membership_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_memberships_customer_tier_uq" ON "customer_memberships" USING btree ("customer_id","tier_id");--> statement-breakpoint
CREATE INDEX "customer_memberships_customer_idx" ON "customer_memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_memberships_tier_idx" ON "customer_memberships" USING btree ("tier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_tiers_site_handle_uq" ON "membership_tiers" USING btree ("site_id","handle");--> statement-breakpoint
CREATE INDEX "membership_tiers_site_idx" ON "membership_tiers" USING btree ("site_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_requires_tier_id_membership_tiers_id_fk" FOREIGN KEY ("requires_tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_grants_tier_id_membership_tiers_id_fk" FOREIGN KEY ("grants_tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_requires_tier_idx" ON "products" USING btree ("requires_tier_id");--> statement-breakpoint
CREATE INDEX "products_grants_tier_idx" ON "products" USING btree ("grants_tier_id");--> statement-breakpoint

-- Handles appear in URLs and are matched case-sensitively by the unique index
-- above, so `Gold` and `gold` would be two tiers that look like one.
ALTER TABLE "membership_tiers" ADD CONSTRAINT "membership_tiers_handle_shape"
  CHECK ("handle" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$');--> statement-breakpoint

-- A membership that ends before it starts is never active, so the gate would
-- silently deny someone the merchant believes they granted.
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_period_ordered"
  CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at");--> statement-breakpoint

-- `source = 'purchase'` is the claim that an order paid for this. Without the
-- order id that claim cannot be checked, and a refund could not find the
-- membership it should revoke.
-- SUPERSEDED: dropped again in 0020 — it contradicts `order_id`'s
-- `on delete set null` and made any order that granted a membership undeletable.
-- Left in place because this migration is already applied; editing it would
-- change its hash and make the migrator re-run it.
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_purchase_has_order"
  CHECK ("source" <> 'purchase' OR "order_id" IS NOT NULL);--> statement-breakpoint

-- A duration with nothing to grant is a value that can never be applied; it
-- reads as configured while doing nothing.
ALTER TABLE "products" ADD CONSTRAINT "products_grants_duration_needs_tier"
  CHECK ("grants_duration_days" IS NULL OR "grants_tier_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_grants_duration_positive"
  CHECK ("grants_duration_days" IS NULL OR "grants_duration_days" > 0);--> statement-breakpoint

-- Deny by default (D6).
ALTER TABLE "membership_tiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_memberships" ENABLE ROW LEVEL SECURITY;