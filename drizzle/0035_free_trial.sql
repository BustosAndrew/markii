-- One free month per merchant account, no card required.
--
-- **This ends the accidental free tier.** `organizations.plan_id` defaults to
-- `starter` and `entitlementsFor` reads it directly, so until now an org that
-- never subscribed got full Starter entitlements — one storefront, a $1,000
-- threshold — forever. The trial replaces that with a month, after which the
-- account is out of standing until a plan is bought.
--
-- `free_trial_ends_at` is deliberately **not** the existing `trial_ends_at`.
-- That column mirrors Stripe's `subscription.trial_end`: `mirrorSubscription`
-- overwrites it on every `customer.subscription.*` event and `mirrorCancellation`
-- nulls it. Storing the signup trial there would have it erased by the first
-- webhook, taking a merchant's store offline in the middle of their free month.
--
-- Neither column is a status. Standing is **derived per request**
-- (`lib/billing/standing.ts`) by comparing this date to now, because nothing in
-- this codebase runs on a clock that could flip a stored flag at the moment a
-- trial lapses — the same reasoning that keeps membership status derived (D34).

ALTER TABLE "organizations" ADD COLUMN "free_trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "trial_reminder_sent_at" timestamp with time zone;--> statement-breakpoint

-- **Backfill, because the alternative takes live stores offline on deploy.**
-- Every existing org predates the trial and would otherwise have a NULL date,
-- which derives as "expired" the instant this ships — storefronts dark, checkout
-- refused, with no warning to a merchant who never agreed to a trial clock.
-- A full month from migration time gives them the same month a new signup gets,
-- and the reminder mail then arrives before anything stops.
--
-- Orgs already carrying a paid subscription are unaffected either way: standing
-- reads the subscription first and never consults this date.
UPDATE "organizations" SET "free_trial_ends_at" = now() + interval '1 month'
  WHERE "free_trial_ends_at" IS NULL;--> statement-breakpoint

-- The reminder sweep's access path: orgs whose trial is closing and who have not
-- been told yet. Partial, because a mailed org is never a candidate again and
-- those accumulate while candidates stay few.
CREATE INDEX "organizations_trial_reminder_idx" ON "organizations" USING btree ("free_trial_ends_at")
  WHERE "free_trial_ends_at" IS NOT NULL AND "trial_reminder_sent_at" IS NULL;
