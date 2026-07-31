/**
 * Fails the build when a table reaches Postgres without RLS, or with the
 * browser-facing roles still granted.
 *
 * Two passes, because neither alone is sufficient:
 *
 *   1. **Static** — scans `drizzle/*.sql`. Runs anywhere, no database, so it
 *      catches a missing `ENABLE ROW LEVEL SECURITY` in review rather than in
 *      production. `drizzle-kit generate` emits no privilege or RLS statements,
 *      so this is pure hand-authored discipline — exactly the kind that decays.
 *   2. **Live** — queries `pg_class` when a connection is configured. Catches
 *      what the static pass structurally cannot: tables created through the
 *      Supabase dashboard, which never appear in a migration file. That is the
 *      known residual gap — `ALTER DEFAULT PRIVILEGES` for the `supabase_admin`
 *      role is not ours to change (see `drizzle/0002_revoke_default_grants.sql`).
 *
 * RLS is not Markii's authorization system — that lives in the action registry
 * (`docs/API.md` §22), and policies must NOT be written here. This is the
 * deny-by-default backstop D6 asked for: a leaked anon key reads nothing.
 *
 * Run: `pnpm check:rls` (also runs as part of `pnpm lint`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

/** Created and managed by drizzle-kit in its own schema — not ours to secure. */
const IGNORED_TABLES = new Set(["__drizzle_migrations"]);

const problems: string[] = [];
const notes: string[] = [];

// ---------------------------------------------------------------------------
// Pass 1 — static scan of the migration chain
// ---------------------------------------------------------------------------

function staticScan() {
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    notes.push("no drizzle/ directory — static scan skipped");
    return;
  }

  const created = new Map<string, string>(); // table -> file that created it
  const rlsEnabled = new Set<string>();

  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

    // `CREATE TABLE "x"` / `CREATE TABLE IF NOT EXISTS "x"`, quoted or bare.
    for (const m of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi,
    )) {
      const table = m[1].toLowerCase();
      if (!IGNORED_TABLES.has(table) && !created.has(table)) created.set(table, file);
    }

    for (const m of sql.matchAll(
      /alter\s+table\s+"?([a-z0-9_]+)"?\s+enable\s+row\s+level\s+security/gi,
    )) {
      rlsEnabled.add(m[1].toLowerCase());
    }
  }

  for (const [table, file] of created) {
    if (!rlsEnabled.has(table)) {
      problems.push(
        `${file}: table "${table}" is created but never gets ENABLE ROW LEVEL SECURITY.\n` +
          `    Append to that migration:  ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;\n` +
          `    (No FORCE — the app connects as table owner, which RLS exempts; forcing it\n` +
          `     with zero policies makes every application query return zero rows.)`,
      );
    }
  }

  notes.push(`static: ${created.size} table(s) across ${files.length} migration file(s)`);
}

// ---------------------------------------------------------------------------
// Pass 2 — live database, when one is configured
// ---------------------------------------------------------------------------

async function liveScan() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    notes.push("live: skipped (no DIRECT_URL/DATABASE_URL configured)");
    return;
  }

  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { prepare: false, connect_timeout: 10, max: 1 });

  try {
    const unprotected = await sql<{ table: string }[]>`
      select c.relname as table
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      order by c.relname`;

    for (const row of unprotected) {
      if (IGNORED_TABLES.has(row.table)) continue;
      problems.push(
        `live: table "public.${row.table}" has RLS disabled.\n` +
          `    If it was created in the Supabase dashboard, add a migration enabling RLS\n` +
          `    rather than toggling it in the UI — the migration chain is the record.`,
      );
    }

    const granted = await sql<{ table_name: string; grantee: string }[]>`
      select distinct table_name, grantee
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')
      order by table_name, grantee`;

    for (const row of granted) {
      problems.push(
        `live: "${row.grantee}" still holds grants on "public.${row.table_name}".\n` +
          `    Supabase auto-grants tables it creates. See drizzle/0002_revoke_default_grants.sql.`,
      );
    }

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_class c
      join pg_namespace n2 on n2.oid = c.relnamespace
      where n2.nspname = 'public' and c.relkind = 'r'`;
    notes.push(`live: ${n} table(s) checked for RLS and browser-role grants`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function main() {
  staticScan();
  await liveScan();

  for (const note of notes) console.log(`  ${note}`);

  if (problems.length > 0) {
    console.error(`\n✖ RLS check failed — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  • ${p}\n`);
    process.exit(1);
  }

  console.log("✔ RLS check passed");
}

main().catch((e) => {
  console.error("RLS check errored:", e);
  process.exit(1);
});
