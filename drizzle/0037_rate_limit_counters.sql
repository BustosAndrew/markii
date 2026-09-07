-- Fixed-window request counters, for rate limiting `/api/mcp`.
--
-- **A table rather than a Map, because a Map would be a lie here.** Module-scope
-- state is per-instance and resets on every cold start, so on a serverless
-- deployment an in-memory limiter refuses close to nothing while looking exactly
-- like protection — the shape of fabricated safety the house rules forbid.
-- Shared state is the only honest version, and Postgres is the shared state this
-- project already has.
--
-- One row per key per window, incremented by a single upsert so two concurrent
-- requests cannot both read the same count and both decide they fit.
--
-- **Nothing sweeps this table, and nothing needs to** — there is no job runner
-- here to sweep with (D41). A key whose window has passed is reset in place on
-- its next request rather than deleted, so the row count is bounded by the
-- number of distinct callers rather than by traffic.
--
-- Be precise about what that bound is: a key that never returns is never
-- reclaimed either, so the true ceiling is every credential that has *ever*
-- called. For real merchants that is a handful of tokens. The integration suite
-- is the exception, minting one per fixture, so `tests/integration/helpers.ts`
-- sweeps rows whose token no longer exists.
--
-- Keys hold token *ids*, never token plaintext or hashes: this table is not a
-- credential store and must never become one by accident.

CREATE TABLE "rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);

-- Deny-by-default, per the standing rule that every table gets RLS even though
-- authorization lives in the action registry rather than in Postgres policies.
--
-- **No FORCE.** The app connects as the table owner, which RLS exempts, so this
-- closes the table to the anon/authenticated browser roles without touching the
-- server's own access. Forcing it with zero policies would make every
-- application query return zero rows — a limiter that counts nothing and allows
-- everything, which is worse than not having one.
ALTER TABLE "rate_limit_counters" ENABLE ROW LEVEL SECURITY;
