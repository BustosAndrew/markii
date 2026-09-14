-- Stripe Tax on Markii's own subscriptions (G3).
--
-- The merchant's billing address, written to their Stripe Customer so that
-- `automatic_tax` on Markii's platform subscription has a location to decide
-- from. Null until the merchant supplies one; a subscription created without
-- it is untaxed and says so in `GET /api/billing/subscription`.
--
-- `organizations.country` already exists and is deliberately not reused: it is
-- the trading country, and a country alone is not a taxable location anywhere
-- Markii sells (US rates are decided below the state line).

ALTER TABLE "organizations" ADD COLUMN "billing_address" jsonb;
