/**
 * Loads `.env.local` for the integration suite.
 *
 * Vitest does not read it, and the rest of the project's tooling gets it via
 * `node --env-file-if-exists` (`pnpm db:seed`, `pnpm check:rls`). Loading the
 * same file here keeps the tests pointed at the same database as everything
 * else rather than a second source of truth someone has to keep in sync.
 *
 * Imported by **both** `setup.ts` and `helpers.ts` on purpose: global setup runs
 * in the main process while test files run in workers, so an env var set in one
 * is not guaranteed to reach the other.
 */
let loaded = false;

export function loadEnvLocal() {
  if (loaded) return;
  loaded = true;
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Absent or unreadable is fine — callers check for what they actually need
    // and report it with a usable message.
  }
}

loadEnvLocal();
