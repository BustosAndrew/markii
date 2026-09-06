import "server-only";

import { and, count, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { actionInvocations, apiTokens, db, staff } from "../db";
import {
  actorKey,
  toAuditEntry,
  type AuditFilters,
  type AuditRow,
  type OrgAuditEntry,
  type ResolvedActor,
} from "./audit";

/**
 * The impure half of the audit log — the query and the name lookups. The
 * decisions live in `./audit`, which stays a pure function of a row.
 */

/**
 * Names for the actors on one page of results.
 *
 * **Batched per page, never per row.** Resolving inside the map would issue one
 * query per entry, so a 100-row page would be 100 round trips to render a list.
 *
 * Scoped to the org being read, so an id belonging to another org resolves to
 * null rather than carrying a name across a tenant boundary — these ids are
 * trusted to be this org's, and scoping makes that not matter.
 */
async function resolveActorNames(
  orgId: string,
  rows: Pick<AuditRow, "actorType" | "actorId">[],
): Promise<Map<string, ResolvedActor>> {
  const out = new Map<string, ResolvedActor>();

  const idsFor = (types: string[]) => [
    ...new Set(
      rows
        .filter((r) => types.includes(r.actorType))
        .map((r) => r.actorId)
        .filter((id): id is string => !!id),
    ),
  ];

  /**
   * Agents resolve through the same staff records as users: an agent acts for a
   * person, and `actorId` is that person's id (§22 — an agent is challenged
   * through the human it acts for).
   */
  const userIds = idsFor(["user", "agent"]);
  const tokenIds = idsFor(["token"]);

  if (userIds.length) {
    const people = await db
      .select({ userId: staff.userId, name: staff.name, email: staff.email })
      .from(staff)
      .where(and(eq(staff.orgId, orgId), inArray(staff.userId, userIds)));
    for (const p of people) {
      if (!p.userId) continue;
      const entry: ResolvedActor = { name: p.name || null, email: p.email };
      out.set(actorKey("user", p.userId), entry);
      out.set(actorKey("agent", p.userId), entry);
    }
  }

  if (tokenIds.length) {
    const tokens = await db
      .select({ id: apiTokens.id, label: apiTokens.label })
      .from(apiTokens)
      .where(and(eq(apiTokens.orgId, orgId), inArray(apiTokens.id, tokenIds)));
    /**
     * Revoked tokens resolve too. Revocation is a soft delete precisely so past
     * audit entries stay attributable, and dropping the name here would throw
     * away the thing that soft delete was protecting.
     */
    for (const t of tokens) {
      out.set(actorKey("token", t.id), { name: t.label, email: null });
    }
  }

  return out;
}

export async function listOrgAudit(
  orgId: string,
  filters: AuditFilters,
  page: { limit: number; offset: number },
): Promise<{ items: OrgAuditEntry[]; total: number }> {
  /**
   * The org scope is the first condition and is never optional — `orgId` comes
   * from the session, never the query string (§16).
   */
  const conds = [eq(actionInvocations.orgId, orgId)];
  if (filters.actorType) conds.push(eq(actionInvocations.actorType, filters.actorType));
  if (filters.actorId) conds.push(eq(actionInvocations.actorId, filters.actorId));
  if (filters.actionId) conds.push(eq(actionInvocations.actionId, filters.actionId));
  if (filters.riskTier) conds.push(eq(actionInvocations.riskTier, filters.riskTier));
  if (filters.ok !== undefined) conds.push(eq(actionInvocations.ok, filters.ok));
  if (filters.from) conds.push(gte(actionInvocations.occurredAt, filters.from));
  if (filters.to) conds.push(lte(actionInvocations.occurredAt, filters.to));

  const where = and(...conds);

  const rows = await db
    .select()
    .from(actionInvocations)
    .where(where)
    .orderBy(desc(actionInvocations.occurredAt))
    .limit(page.limit)
    .offset(page.offset);

  /**
   * Counted under the same filters, so "showing 20 of 340" is 340 matching
   * rows rather than the org's whole history.
   */
  const [totalRow] = await db.select({ c: count() }).from(actionInvocations).where(where);

  const names = await resolveActorNames(orgId, rows);

  return {
    total: Number(totalRow?.c ?? 0),
    items: rows.map((r) => toAuditEntry(r as AuditRow, names)),
  };
}
