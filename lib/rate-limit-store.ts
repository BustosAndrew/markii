import "server-only";

import { sql } from "drizzle-orm";
import { db, rateLimitCounters } from "./db";
import {
  decide,
  windowStartFor,
  type RateLimitDecision,
  type RateLimitPolicy,
} from "./rate-limit";

/**
 * The database half of rate limiting — the atomic increment.
 *
 * **One statement, not read-then-write.** Two concurrent requests that both
 * read `count = 119` against a limit of 120 would both decide they were allowed
 * and both write 120, letting a burst straight through. The upsert below reads
 * and writes inside a single statement, so Postgres serialises the row and the
 * count is exact whatever the concurrency.
 */

/**
 * Count this request and decide whether it may proceed.
 *
 * **Fails open.** If the counter cannot be written — the database is down, the
 * migration has not run — the request is allowed. Rate limiting is an abuse
 * control, not an authorization check: refusing every caller because a counter
 * table is unreachable turns a degraded dependency into a full outage, and
 * nothing here is the thing standing between an attacker and the data. The
 * permission check, the approval gate and the audit log are, and none of them
 * depends on this.
 */
export async function consumeRateLimit(
  key: string,
  policy: RateLimitPolicy,
  now: Date = new Date(),
): Promise<RateLimitDecision> {
  const windowStart = windowStartFor(now, policy.windowMs);

  try {
    const [row] = await db
      .insert(rateLimitCounters)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: rateLimitCounters.key,
        /**
         * A row from an earlier window is reset rather than deleted, which is
         * what keeps this table bounded by the number of distinct callers
         * instead of by traffic — and means no sweeper is needed for a thing
         * nothing schedules.
         */
        set: {
          count: sql`case when ${rateLimitCounters.windowStart} < ${windowStart.toISOString()}
                     then 1 else ${rateLimitCounters.count} + 1 end`,
          windowStart: sql`case when ${rateLimitCounters.windowStart} < ${windowStart.toISOString()}
                           then ${windowStart.toISOString()} else ${rateLimitCounters.windowStart} end`,
        },
      })
      .returning({ count: rateLimitCounters.count, windowStart: rateLimitCounters.windowStart });

    if (!row) return allow(windowStart, policy);
    return decide(row.count, row.windowStart, policy);
  } catch (e) {
    console.error("[rate-limit] counter unavailable, allowing request", e);
    return allow(windowStart, policy);
  }
}

function allow(windowStart: Date, policy: RateLimitPolicy): RateLimitDecision {
  return decide(1, windowStart, policy);
}
