-- ---------------------------------------------------------------------------
-- Tenancy: org-scope sites and integrations (§16).
--
-- Hand-authored. drizzle-kit could not generate this: it does not know the name
-- of the primary key it needs to drop, and its `ADD COLUMN "id" text PRIMARY KEY
-- NOT NULL` fails outright on a table that already has rows.
--
-- `integrations.provider` was the primary key, which made the table silently
-- single-tenant — the second org to connect Stripe would have overwritten the
-- first one's secret key. It becomes a surrogate id with a unique
-- (org_id, provider).
--
-- `org_id` is nullable on both tables **for the duration of the backfill**.
-- NULL fails closed: `where org_id = $1` never matches it, so an unassigned row
-- is invisible to everyone rather than visible to all. A follow-up migration
-- tightens it to NOT NULL once nothing is orphaned.
-- ---------------------------------------------------------------------------

ALTER TABLE "sites" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sites_org_idx" ON "sites" USING btree ("org_id");--> statement-breakpoint

-- integrations: provider-PK → surrogate id + (org_id, provider)
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_pkey";--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "id" text;--> statement-breakpoint
-- Backfill before NOT NULL, or the constraint fails on every existing row.
UPDATE "integrations" SET "id" = 'int_' || replace(gen_random_uuid()::text, '-', '') WHERE "id" IS NULL;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_pkey" PRIMARY KEY ("id");--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Postgres treats NULLs as distinct in a unique index, so orphaned rows with a
-- NULL org_id do not collide with each other while the backfill is outstanding.
CREATE UNIQUE INDEX "integrations_org_provider_uq" ON "integrations" USING btree ("org_id","provider");--> statement-breakpoint
CREATE INDEX "integrations_org_idx" ON "integrations" USING btree ("org_id");
