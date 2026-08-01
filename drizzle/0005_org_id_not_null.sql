-- ---------------------------------------------------------------------------
-- Close the tenancy backfill: sites.org_id and integrations.org_id become
-- NOT NULL (§16).
--
-- 0004 left both nullable so the column could be added to a table with rows.
-- NULL failed closed — an unassigned row matched no org filter and was
-- invisible rather than public — but "invisible" is a weaker guarantee than
-- "cannot exist", and only the constraint makes it structural.
--
-- The guard below turns a cryptic constraint violation into an actionable one.
-- If it fires, assign the orphans to an org (or delete them) and re-run; do not
-- weaken the constraint.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  orphan_sites        bigint;
  orphan_integrations bigint;
BEGIN
  SELECT count(*) INTO orphan_sites FROM sites WHERE org_id IS NULL;
  SELECT count(*) INTO orphan_integrations FROM integrations WHERE org_id IS NULL;
  IF orphan_sites > 0 OR orphan_integrations > 0 THEN
    RAISE EXCEPTION
      'Cannot set org_id NOT NULL: % site(s) and % integration(s) have no organization. Assign or delete them first.',
      orphan_sites, orphan_integrations;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ALTER COLUMN "org_id" SET NOT NULL;
