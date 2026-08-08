-- Recurring memberships (§18.9) — the piece that was blocked on Phase B.
--
-- **Stripe is the scheduler, and that is the whole design.** Nothing in this
-- deployment runs jobs — the same constraint that keeps membership status
-- derived rather than stored, readiness issues unstored, and the §4.5 rollup
-- unbuilt. A renewal Markii had to trigger itself would therefore simply never
-- happen. Making the sale a Stripe Subscription puts the recurrence somewhere
-- that does have a scheduler.
--
-- The subscription lives on the **merchant's own connected account**: the
-- shopper pays the merchant, Markii takes no application fee and is never in the
-- funds flow (D4). This is the opposite direction from `organizations.stripe_*`,
-- which is Markii charging the merchant.
ALTER TABLE "customer_memberships" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint

-- When the renewal was stopped. Access continues to `ends_at` — the member paid
-- for the period, and ending it early would delete time they already bought.
--
-- Deliberately separate from `revoked_at`, which is the merchant taking access
-- away *now*. "I cancelled" and "they removed me" are different facts, and a
-- member asking why their access stopped needs them told apart — the same reason
-- `revoked_at` was split from `ends_at` in the first place.
ALTER TABLE "customer_memberships" ADD COLUMN "renewal_canceled_at" timestamp with time zone;--> statement-breakpoint

-- The shopper as a Customer on the **merchant's** Stripe account, created only
-- when they buy a recurring membership. Scoped to the store for the same reason
-- the customer row is: they are the merchant's customer, not Markii's.
ALTER TABLE "customers" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint

-- 'none' keeps every existing product exactly as it behaves today: a one-off
-- purchase that extends access and then lapses. Recurring is opt-in per product,
-- never inferred from having a tier.
ALTER TABLE "products" ADD COLUMN "grants_renewal_interval" text DEFAULT 'none' NOT NULL;--> statement-breakpoint

-- The recurring Price on the merchant's account. Stored rather than recreated
-- per checkout, which would scatter their dashboard with duplicates of one plan.
ALTER TABLE "products" ADD COLUMN "stripe_recurring_price_id" text;--> statement-breakpoint

-- How a renewal webhook finds the membership to extend. Unique because one
-- subscription renews exactly one membership — two rows claiming it would both
-- be extended by a single payment.
CREATE UNIQUE INDEX "customer_memberships_stripe_subscription_uq" ON "customer_memberships" USING btree ("stripe_subscription_id");--> statement-breakpoint

-- Unique per SITE, not globally. Two merchants' Stripe accounts can each mint a
-- `cus_…` with the same id, and a global unique would reject the second
-- merchant's shopper over a collision that is not one.
CREATE UNIQUE INDEX "customers_site_stripe_customer_uq" ON "customers" USING btree ("site_id","stripe_customer_id");--> statement-breakpoint

-- Drizzle's `text(..., { enum })` is a TypeScript type, not a database
-- constraint. This is what actually keeps the column to the three intervals,
-- matching the checks added for subscription status in 0026.
ALTER TABLE "products" ADD CONSTRAINT "products_grants_renewal_interval_valid"
  CHECK ("grants_renewal_interval" IN ('none', 'month', 'year'));--> statement-breakpoint

-- A product cannot renew into a tier it does not grant. Without this, a merchant
-- could set an interval on an ordinary product and Markii would open a
-- subscription that confers nothing — charging a shopper monthly for no access.
ALTER TABLE "products" ADD CONSTRAINT "products_renewal_requires_tier"
  CHECK ("grants_renewal_interval" = 'none' OR "grants_tier_id" IS NOT NULL);--> statement-breakpoint

-- A subscription renews a membership; a cancelled renewal implies there was one.
-- Both directions of a half-written link would leave "what happens next?"
-- unanswerable from the row.
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_cancel_implies_subscription"
  CHECK ("renewal_canceled_at" IS NULL OR "stripe_subscription_id" IS NOT NULL);
