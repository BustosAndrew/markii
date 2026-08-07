ALTER TABLE "usage_records" ADD COLUMN "product_class" text;--> statement-breakpoint

-- Nullable on purpose, and NOT backfilled. A null means "metered before physical
-- and digital had separate rates" (docs/PRICING.md §3). Backfilling everything to
-- 'physical' would be a guess about real money that silently moves historical
-- sales onto one of two thresholds; the meter reports unclassified records as the
-- gap they are, exactly as it already does for records with no FX conversion.
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_product_class_values"
  CHECK ("product_class" IS NULL OR "product_class" IN ('physical', 'digital'));
