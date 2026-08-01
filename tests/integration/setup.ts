import postgres from "postgres";
import "./env";

/**
 * Guards for the integration suite.
 *
 * These tests **write to a real database** and drive a **real dev server**.
 * Markii has one Supabase project, so "the test database" and "the database" are
 * currently the same thing — which makes an accidental run a real hazard rather
 * than a theoretical one.
 *
 * `pnpm test` is not the risk: it names the `unit` project and cannot reach
 * these. The risk is a bare `vitest run`, which picks up **every** project. Three
 * checks stand between that and someone's data:
 *
 * 1. An explicit opt-in env var. Nothing runs without it being set on purpose.
 * 2. A refusal to touch a connection string that looks like production.
 * 3. A reachable dev server, checked up front so a failure reads as "start the
 *    server" rather than fifty confusing assertion errors.
 *
 * Every test still cleans up what it creates. The guards are for the case where
 * that is not enough.
 */

export const BASE_URL = process.env.MARKII_TEST_BASE_URL ?? "http://localhost:3000";

export default async function setup() {
  if (process.env.MARKII_ALLOW_INTEGRATION_TESTS !== "1") {
    throw new Error(
      "Integration tests write to a real database and are opt-in.\n" +
        "Run them with:  pnpm test:integration\n" +
        "(which sets MARKII_ALLOW_INTEGRATION_TESTS=1), and only against a database you are " +
        "willing to have rows created and deleted in.",
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — integration tests need a real database.");
  }

  /**
   * A deliberately blunt production check. It cannot know which Supabase project
   * is which, so it refuses anything explicitly labelled production and leaves
   * the rest to the opt-in above.
   */
  if (/prod|production/i.test(url)) {
    throw new Error(
      "DATABASE_URL looks like a production database. Integration tests refuse to run against it.",
    );
  }

  // Fail early and legibly if the server is not up.
  try {
    const res = await fetch(`${BASE_URL}/api/me`, {
      signal: AbortSignal.timeout(10_000),
    });
    // 401 is the expected answer for an unauthenticated caller — it proves the
    // server is up and routing, which is all this check is for.
    if (res.status >= 500) {
      throw new Error(`dev server returned ${res.status}`);
    }
  } catch (e) {
    throw new Error(
      `No dev server reachable at ${BASE_URL}.\n` +
        "Start one in another terminal:  DEMO_SKIP_PAYMENT_VERIFICATION=1 pnpm dev\n" +
        `(underlying error: ${e instanceof Error ? e.message : String(e)})`,
    );
  }

  /**
   * A reminder, not a detection: this process cannot see the *server's*
   * environment, and checking its own would report the wrong thing confidently.
   * Without the flag the server tries to verify payments on-chain and the
   * checkout-completion tests fail with a payment error rather than a useful one.
   */
  console.info(
    "\n  reminder: the dev server must be running with DEMO_SKIP_PAYMENT_VERIFICATION=1,\n" +
      "  or checkout-completion tests will try to settle payments on-chain.\n",
  );

  const sql = postgres(url, { prepare: false });
  try {
    await sql`select 1`;
  } finally {
    await sql.end();
  }
}
