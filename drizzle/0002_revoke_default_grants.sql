-- ---------------------------------------------------------------------------
-- Stop Supabase auto-granting every NEW table to anon/authenticated.
-- Hand-authored (drizzle-kit generates no privilege statements).
--
-- Supabase ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES
-- TO anon, authenticated` because its default architecture is browser →
-- PostgREST. Markii's is browser → /api/* → Postgres over a direct connection,
-- and the Data API is disabled, so those grants serve no traffic.
--
-- Migration 0000 revoked the grants on the tables that existed at the time. That
-- was a one-shot fix to a standing rule: `action_invocations` (created in 0001)
-- was granted all over again, and so would every future table. This changes the
-- default itself, so new tables arrive ungranted and no migration has to
-- remember — structure rather than discipline (docs/BACKEND.md).
--
-- RLS is still the thing that actually denies access (0000/0001); this removes
-- the grant that RLS would otherwise be the only guard against.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  target_role text;
  creator     text;
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      CONTINUE;  -- plain Postgres, not Supabase
    END IF;

    -- Existing tables.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);

    -- Future tables, per role that creates them. `postgres` runs migrations;
    -- `supabase_admin` owns objects created through the dashboard. We may lack
    -- membership in the latter, so a failure there is tolerated rather than
    -- fatal — it only affects tables created outside this migration chain.
    FOREACH creator IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = creator) THEN
        CONTINUE;
      END IF;
      BEGIN
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
          creator, target_role);
        EXECUTE format(
          'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
          creator, target_role);
      EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
        RAISE NOTICE 'skipped default privileges for creator % (insufficient rights)', creator;
      END;
    END LOOP;
  END LOOP;
END $$;
