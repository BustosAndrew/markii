import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Supabase connection (D6). Two connection strings exist and they are not
 * interchangeable:
 *
 * - `DATABASE_URL` — **transaction-mode pooler, port 6543**. Every app query.
 * - `DIRECT_URL`   — **session mode, port 5432**. Migrations only (`drizzle.config.ts`);
 *                    a pooled connection cannot run DDL.
 *
 * Nothing in the running app should reach for `DIRECT_URL`.
 */
const connectionString = process.env.DATABASE_URL ?? null;

/**
 * Keeps `next build` working before the database is configured — the same
 * guarantee the Neon placeholder gave. postgres.js connects lazily, so an
 * unconfigured deploy fails at query time (a 500 from the route, per
 * `docs/API.md`) rather than at import time, which would break every page.
 */
const PLACEHOLDER = "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";

function createClient() {
  return postgres(connectionString ?? PLACEHOLDER, {
    /**
     * Required by the transaction pooler: pgBouncer in transaction mode hands a
     * different backend to each statement, so a prepared statement named on one
     * connection is missing on the next ("prepared statement s1 already exists"
     * / "does not exist"). Non-negotiable while port 6543 is in use.
     */
    prepare: false,
    /**
     * Fluid Compute reuses an instance across concurrent requests, so a
     * single-socket pool serialises them. A small pool per instance is the
     * balance — the pooler upstream is what protects Postgres' connection limit.
     */
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

/**
 * One client per process. Dev's module reloading would otherwise open a new
 * pool on every edit until the pooler refuses connections.
 */
const globalForDb = globalThis as unknown as { markiiSql?: ReturnType<typeof createClient> };

export const sql = globalForDb.markiiSql ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.markiiSql = sql;

export const db = drizzle(sql, { schema });

/** False when `DATABASE_URL` is unset — routes surface *configuration required*, never fake data. */
export function isDatabaseConfigured() {
  return connectionString !== null;
}

export * from "./schema";
