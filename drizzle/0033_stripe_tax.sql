-- Stripe Tax (§18.6, `docs/DECISIONS.md` G3).
--
-- Six columns across four tables, tracing one calculation from the cart that
-- asked for it to the refund that reverses it. Every one is nullable, and that
-- is the point: a `manual`-rate store, a `provider: "none"` store, and every
-- order placed before today have tax Stripe was never asked about, so a default
-- here would claim otherwise.
--
-- **The cart columns are a cost control, not a convenience.** Stripe bills the
-- merchant per calculation and `priceCart` runs on every cart render, so calling
-- Stripe each time would charge a merchant for a shopper reloading a page. The
-- fingerprint covers everything that can change the answer — line amounts,
-- shipping, destination, and the store's own settings — so a cache hit is only
-- ever the same question asked again.
--
-- The cache is **per cart** rather than per store on purpose. A calculation
-- converts into exactly one Stripe Tax transaction; two carts sharing a cached
-- id would leave the second sale missing from the merchant's tax report, which
-- is invisible until they file.

ALTER TABLE "carts" ADD COLUMN "tax_calculation_id" text;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "tax_calculation_fingerprint" text;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "tax_calculation_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "tax_calculation_result" jsonb;--> statement-breakpoint

-- Frozen with the quote, beside the amounts it produced. The cart's cache moves
-- when the shopper edits their basket; the session's copy must not, or the
-- merchant's tax transaction would be created from a calculation for a
-- different order than the one that was paid for.
ALTER TABLE "checkout_sessions" ADD COLUMN "tax_calculation_id" text;--> statement-breakpoint

-- Set only when Stripe both calculated the tax and accepted the transaction, so
-- its presence is the one honest answer to "is this order in the merchant's
-- Stripe Tax report?" — and it is what a refund reverses against.
ALTER TABLE "orders" ADD COLUMN "tax_transaction_id" text;--> statement-breakpoint

-- Null means no reversal was recorded — either the order was never in Stripe
-- Tax, or the call failed after the refund committed. The second leaves the
-- merchant's report overstating what they collected, which is a reconciliation
-- problem rather than a money one, so it is recorded as absent rather than
-- allowed to block a refund the shopper is owed.
ALTER TABLE "refunds" ADD COLUMN "tax_reversal_id" text;
