-- Storefront search (G6): Postgres full-text search over products.
--
-- A **stored generated column** rather than a trigger-maintained one or a
-- column the application writes: it cannot lag the fields it indexes, and
-- nothing that updates a product — an action, the importer, the seed script,
-- a hand-run UPDATE — has to remember it exists.
--
-- Name and SKU carry weight A and the description weight B, so a product named
-- for the query outranks one that mentions it in passing. The description is
-- stripped of HTML tags before indexing; without that every product would match
-- a search for "strong" or "p".
--
-- `english` is fixed in the expression because a generated column's expression
-- must be immutable, and `to_tsvector(text)` without a config reads a session
-- setting. The launch countries are English-speaking (G2); `lib/storefront/
-- search.ts` falls back to a substring match for anything the stemmer misses.
--
-- Nothing else here: no RLS change, because `products` already carries it.

ALTER TABLE "products" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("name", '')), 'A') || setweight(to_tsvector('english', coalesce("sku", '')), 'A') || setweight(to_tsvector('english', regexp_replace(coalesce("description", ''), '<[^>]*>', ' ', 'g')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin ("search_vector");
