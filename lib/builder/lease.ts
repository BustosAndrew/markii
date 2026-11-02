import "server-only";

import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { ApiError } from "@/lib/api";
import { db, siteDesigns } from "@/lib/db";
import { leaseActive } from "./store";

/**
 * The brand agent's edit lease (D51; owner, 2026-10-31: **one writer at a
 * time**, and the agent holds the pen while a turn runs).
 *
 * Runtime state of an agent turn, like the session row it names — taken,
 * renewed and handed back by the turn loop in `lib/ops-agents`, never by a
 * person. The one thing a person does to it, Stop, is a registry action
 * (`builder.stopAgent`) because that is a decision someone made and the next
 * turn needs a record of it.
 *
 * **The lease is what the draft actions check** (`assertMayWrite` in
 * `./store`, under the design row's `FOR UPDATE`), so it is enforced on every
 * surface — dashboard, HTTP API, MCP — not just in the editor's UI.
 *
 * Expiry is the backstop for a turn that dies without releasing: a crashed
 * function stops renewing, and the site frees itself within a minute.
 * Timestamps are the app's clock on both sides of every comparison, never the
 * database's `now()`, so a skew between the two cannot shorten or extend it.
 */

/** How long a lease lasts unrenewed. */
export const AGENT_LEASE_MS = 60_000;

/** How often a running turn renews — several times per lease, so one slow write does not lose it. */
export const AGENT_LEASE_RENEW_MS = 15_000;

/**
 * Take the lease for a turn. Refuses while another turn holds it — including
 * an earlier turn of the same conversation that is still running, so a double
 * send cannot run two turns against one draft.
 */
export async function acquireAgentLease(siteId: number, sessionId: string): Promise<Date> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AGENT_LEASE_MS);
  const [taken] = await db
    .update(siteDesigns)
    .set({ agentLockSessionId: sessionId, agentLockExpiresAt: expiresAt })
    .where(
      and(
        eq(siteDesigns.siteId, siteId),
        or(isNull(siteDesigns.agentLockSessionId), isNull(siteDesigns.agentLockExpiresAt), lte(siteDesigns.agentLockExpiresAt, now)),
      ),
    )
    .returning({ siteId: siteDesigns.siteId });
  if (taken) return expiresAt;

  const [design] = await db.select().from(siteDesigns).where(eq(siteDesigns.siteId, siteId)).limit(1);
  if (!design) {
    throw new ApiError("CONFLICT", 409, "This site's design has not been started. Open the editor first.", {
      reason: "design_not_started",
    });
  }
  const same = leaseActive(design, now) && design.agentLockSessionId === sessionId;
  throw new ApiError(
    "AGENT_EDITING",
    409,
    same
      ? "The brand agent is still working on your last message. Wait for it to finish, or press Stop."
      : "The brand agent is already editing this site's design in another conversation. Stop it first.",
    {
      reason: same ? "turn_in_progress" : "agent_holds_lease",
      sessionId: design.agentLockSessionId,
      expiresAt: design.agentLockExpiresAt?.toISOString() ?? null,
    },
  );
}

/** Extend a lease this session still holds. False when it was stopped or lapsed — the turn must end. */
export async function renewAgentLease(siteId: number, sessionId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(siteDesigns)
    .set({ agentLockExpiresAt: new Date(now.getTime() + AGENT_LEASE_MS) })
    .where(
      and(
        eq(siteDesigns.siteId, siteId),
        eq(siteDesigns.agentLockSessionId, sessionId),
        // A lapsed lease is not revived: someone may have started editing in the gap.
        gt(siteDesigns.agentLockExpiresAt, now),
      ),
    )
    .returning({ expiresAt: siteDesigns.agentLockExpiresAt });
  return rows.length > 0;
}

/**
 * Hand the lease back at the end of a turn. Conditional on still holding it, so
 * a turn ending late cannot release a lease a newer turn has since taken.
 * Never throws: it runs after the reply has streamed, and the expiry covers a
 * release that fails.
 */
export async function releaseAgentLease(siteId: number, sessionId: string): Promise<void> {
  try {
    await db
      .update(siteDesigns)
      .set({ agentLockSessionId: null, agentLockExpiresAt: null })
      .where(and(eq(siteDesigns.siteId, siteId), eq(siteDesigns.agentLockSessionId, sessionId)));
  } catch (e) {
    console.error("[builder] could not release the agent lease", { siteId, sessionId, error: e });
  }
}
