import { readFileSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't load .env.local on its own
if (!process.env.DATABASE_URL) {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // no .env.local yet
  }
}

/**
 * Migrations run over the **session-mode** connection (port 5432), never the
 * transaction pooler on 6543: pgBouncer in transaction mode cannot run DDL.
 * `DATABASE_URL` is the fallback only so a local, unpooled Postgres still works
 * with a single variable set.
 */
const migrationUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";

if (process.env.DIRECT_URL == null && migrationUrl.includes(":6543")) {
  throw new Error(
    "Refusing to migrate over the transaction pooler (:6543) — DDL fails there. " +
      "Set DIRECT_URL to the session-mode connection string (:5432). See .env.example.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: migrationUrl },
});
