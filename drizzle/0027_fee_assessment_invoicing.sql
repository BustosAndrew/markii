-- Threshold-fee invoicing (§17, docs/PRICING.md §4) — the line between a
-- measurement and a charge.
--
-- `fee_assessments` has always recorded what a period *measured*; `invoiced` was
-- hardcoded false and every surface said so. These two columns are what let a
-- closed assessment become money actually owed, and what make that transition
-- auditable afterwards.
--
-- An invoice **item**, not an invoice: the fee rides onto the merchant's next
-- subscription invoice as a named line, which is what PRICING.md promises and
-- what avoids billing one relationship twice a month with two dunning paths.
ALTER TABLE "fee_assessments" ADD COLUMN "stripe_invoice_item_id" text;--> statement-breakpoint
ALTER TABLE "fee_assessments" ADD COLUMN "invoiced_at" timestamp with time zone;--> statement-breakpoint

-- One assessment per Stripe invoice item. Two rows pointing at the same item
-- would mean one charge was recorded as billing two periods — and the second
-- period would then silently never be billed at all.
--
-- Nulls are distinct in a Postgres unique index, so every assessment that owes
-- nothing (and every one closed before this migration) coexists here.
CREATE UNIQUE INDEX "fee_assessments_invoice_item_uq" ON "fee_assessments" USING btree ("stripe_invoice_item_id");--> statement-breakpoint

-- An assessment that claims to be billed must say when. "Invoiced, at no
-- particular time" cannot answer the first question asked in a billing dispute,
-- which is the same reason `stripe_webhook_events` requires a settled time
-- (0021).
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_invoiced_has_time"
  CHECK ("invoiced" = false OR "invoiced_at" IS NOT NULL);--> statement-breakpoint

-- A Stripe invoice item exists only for something that was billed. The reverse
-- is deliberately allowed: a merchant under their threshold owes nothing, and
-- that period is *settled* with no item rather than left pending forever.
ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_item_implies_invoiced"
  CHECK ("stripe_invoice_item_id" IS NULL OR "invoiced" = true);
