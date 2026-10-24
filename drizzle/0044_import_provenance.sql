-- Import provenance (D49, docs/API.md §5): where an imported product came from.
-- Additive and nullable — every existing product reads as made in Markii, and code
-- deployed before this migration ignores the columns. Written only by
-- /api/import/commit; no route accepts them as input.
--
-- import_source_id is the source platform's own product id; the partial index
-- serves the re-import check (has this site already brought that product in?).

ALTER TABLE "products" ADD COLUMN "import_source" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "import_source_url" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "import_source_id" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "products_import_source_idx" ON "products" USING btree ("site_id","import_source","import_source_id") WHERE "products"."import_source_id" is not null;