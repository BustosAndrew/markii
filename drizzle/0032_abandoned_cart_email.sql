-- Abandoned-cart email (D27 — "abandoned cart ships free").
--
-- Two columns, and the defaults are the design.
--
-- `sites.abandoned_cart_emails` is **opt-in, default false**. This mail goes out
-- from the merchant's own sending domain, to their own customers, and lands on
-- their sending reputation. Switching it on for every store at once because
-- Markii shipped a feature would be sending on their behalf without being asked
-- — and the merchants most likely to be harmed are the ones not watching.
--
-- `carts.abandoned_mail_sent_at` is what makes the sweep idempotent. The cron
-- runs hourly and selects on a time window; without a durable marker a cart
-- sitting inside that window would be mailed on every run, which is precisely
-- the behaviour that gets a sending domain blocked.

ALTER TABLE "carts" ADD COLUMN "abandoned_mail_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "abandoned_cart_emails" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- The sweep's access path: open carts with an address, ordered by when they went
-- quiet. Partial, because a converted cart is never a candidate and there will
-- eventually be far more of those than open ones.
CREATE INDEX "carts_abandoned_sweep_idx" ON "carts" USING btree ("updated_at")
  WHERE "status" = 'open' AND "email" IS NOT NULL AND "abandoned_mail_sent_at" IS NULL;
