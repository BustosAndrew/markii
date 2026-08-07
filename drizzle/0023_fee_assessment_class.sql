DROP INDEX "fee_assessments_period_uq";--> statement-breakpoint
ALTER TABLE "fee_assessments" ADD COLUMN "product_class" text;--> statement-breakpoint

ALTER TABLE "fee_assessments" ADD CONSTRAINT "fee_assessments_product_class_values"
  CHECK ("product_class" IS NULL OR "product_class" IN ('physical', 'digital'));--> statement-breakpoint

-- NULLS NOT DISTINCT is the point of this index, not a detail.
--
-- A period now closes into one assessment per fee class (docs/PRICING.md §3), so
-- the key has to include the class. But `product_class` is nullable for
-- assessments closed before the split, and Postgres treats NULLs as DISTINCT in a
-- unique index by default — which would let the same legacy period be closed
-- twice and assessed twice. That is the exact double-billing this key exists to
-- prevent, so the null has to collide with itself.
CREATE UNIQUE INDEX "fee_assessments_period_uq"
  ON "fee_assessments" USING btree ("org_id", "period_start", "product_class") NULLS NOT DISTINCT;
