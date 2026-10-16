import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { agentUsage, db, type AgentKind } from "../db";
import { allowanceFor, usagePeriodStart, type AgentAllowance } from "./config";

/**
 * The beta usage ledger (D47) — tokens per turn, summed per org per month.
 */

/** Where the org stands against this month's allowance. */
export async function allowanceForOrg(orgId: string, now = new Date()): Promise<AgentAllowance> {
  const [row] = await db
    .select({
      used: sql<string>`coalesce(sum(${agentUsage.inputTokens} + ${agentUsage.outputTokens}), 0)`,
    })
    .from(agentUsage)
    .where(and(eq(agentUsage.orgId, orgId), gte(agentUsage.createdAt, usagePeriodStart(now))));
  return allowanceFor(Number(row?.used ?? 0), now);
}

/**
 * Record one turn's spend.
 *
 * **Never throws.** It runs after the reply has streamed; a failed write must
 * not turn a finished answer into an error. The cost of losing a row is that
 * one turn goes uncounted against a free beta's cap, which is the survivable
 * direction — logged loudly so a pattern of it is noticed.
 */
export async function recordUsage(entry: {
  orgId: string;
  sessionId: string;
  agent: AgentKind;
  model: string;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}): Promise<void> {
  try {
    await db.insert(agentUsage).values({
      orgId: entry.orgId,
      sessionId: entry.sessionId,
      agent: entry.agent,
      model: entry.model,
      inputTokens: Math.max(0, Math.trunc(entry.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.trunc(entry.outputTokens ?? 0)),
    });
  } catch (e) {
    console.error("[agents] could not record usage", { sessionId: entry.sessionId, error: e });
  }
}
