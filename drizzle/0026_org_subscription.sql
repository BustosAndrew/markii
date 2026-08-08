-- Markii's own subscription billing (§17) — the half that charges *the merchant*.
--
-- Every column here mirrors Stripe on **Markii's platform account**, not on a
-- merchant's Connect account. The two directions of money must never share
-- storage: `lib/payments/` moves a shopper's money into the merchant's own
-- balance and takes no cut (D4), while this is Markii invoicing the merchant for
-- software. A subscription written against a connected account would bill the
-- merchant's customers for Markii's product.
--
-- All nullable, and that is the pre-billing state rather than a gap: an org with
-- no subscription is every org that exists today. `plan_id` already defaults to
-- 'starter', so entitlements keep working untouched while nothing is charged.
ALTER TABLE "organizations" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "subscription_status" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "subscription_interval" text;--> statement-breakpoint

-- The **Stripe billing** period, which is deliberately not the metering period.
-- Threshold fees are measured over calendar months into `fee_assessments`; these
-- bounds are when the subscription renews. A screen that showed one as the other
-- would tell a merchant their fee window is something it is not.
ALTER TABLE "organizations" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Webhooks arrive knowing only Stripe's ids, so these are the lookups that
-- resolve an event to a tenant. Unique because two organizations sharing a
-- customer or a subscription would make that resolution ambiguous — and the
-- wrong answer silently changes somebody else's entitlements.
--
-- Postgres treats NULLs as distinct in a unique index, so every org that has
-- never subscribed coexists here without collision.
CREATE UNIQUE INDEX "organizations_stripe_customer_uq" ON "organizations" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_stripe_subscription_uq" ON "organizations" USING btree ("stripe_subscription_id");--> statement-breakpoint

-- Drizzle's `text(..., { enum })` is a **TypeScript** type, not a database
-- constraint — nothing in the generated DDL stops a bad value. These are what
-- actually keep the column to Stripe's vocabulary, mirroring the check
-- constraints on `stripe_webhook_events` (0021) for the same reason: a column
-- that decides entitlements should not accept a typo.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_subscription_status_valid"
  CHECK ("subscription_status" IS NULL OR "subscription_status" IN
    ('trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused'));--> statement-breakpoint

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_subscription_interval_valid"
  CHECK ("subscription_interval" IS NULL OR "subscription_interval" IN ('month','year'));--> statement-breakpoint

-- A live subscription id with no status is a half-written mirror, and a reader
-- would have to guess which half to believe.
--
-- Deliberately **one-directional**. The reverse is a real and necessary state: a
-- cancellation drops the id (Stripe deleted the object, and keeping it would
-- leave the org pointing at something that 404s) while keeping
-- `subscription_status = 'canceled'`, which is what a merchant needs to see on
-- the billing screen. `mirrorCancellation` writes exactly that.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_subscription_mirror_complete"
  CHECK ("stripe_subscription_id" IS NULL OR "subscription_status" IS NOT NULL);
