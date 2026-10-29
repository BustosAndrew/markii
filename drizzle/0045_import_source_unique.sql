-- One product per source product per site (D49, docs/API.md §5). 0044 indexed the
-- re-import lookup; this makes it a guarantee. The commit route checks first and
-- reports "already imported", but two commits of one import racing each other both
-- pass that check — only a unique index stops the second. Checked before applying:
-- no (site_id, import_source, import_source_id) duplicates existed.

DROP INDEX "products_import_source_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "products_import_source_uq" ON "products" USING btree ("site_id","import_source","import_source_id") WHERE "products"."import_source_id" is not null;