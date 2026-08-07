ALTER TABLE "orders" ADD COLUMN "payment_reference" text;--> statement-breakpoint
CREATE INDEX "orders_payment_reference_idx" ON "orders" USING btree ("payment_reference");--> statement-breakpoint

-- Backfilled from tx_hash for the x402 rail, and that is a copy rather than a
-- guess: completeCheckout has always written `tx_hash = paymentReference` for
-- x402, so the two columns already hold the same fact for every existing order.
-- Doing it here means a null in payment_reference means "this rail recorded no
-- reference", not "this order predates the column" — an invariant the refund and
-- charge.refunded paths can rely on.
--
-- Nothing to backfill on the Stripe side: no card payment has ever been taken on
-- this deployment, and a Stripe order's intent id lived only on the checkout
-- session, which is exactly the gap this column closes.
UPDATE "orders" SET "payment_reference" = "tx_hash"
  WHERE "provider" = 'x402' AND "tx_hash" IS NOT NULL;
