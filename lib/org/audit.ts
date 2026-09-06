import type { DiffEntry } from "../db";

/**
 * The shape of the org audit log (`docs/API.md` §16), and the pure derivations
 * that build one entry from one `action_invocations` row.
 *
 * **One history, not a second one.** §22 rule 5 already records every
 * invocation, so §16 adds a *view* rather than a table: an audit log assembled
 * from its own writes would drift from the registry's the first time someone
 * forgot to write to both. `/api/actions/invocations` is the same rows seen
 * from the registry's side.
 *
 * Split from `./audit-query` for the reason `standing` is split from
 * `standing-guard`: the mapping is where the decisions live — what a missing
 * actor name means, which entities a diff touched, how a refusal is reported —
 * and that part must be testable without a database.
 */

/** Actor types as the audit table records them. */
export const AUDIT_ACTOR_TYPES = ["user", "agent", "token", "system"] as const;
export const AUDIT_RISK_TIERS = ["read", "low", "medium", "high"] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export type AuditRiskTier = (typeof AUDIT_RISK_TIERS)[number];

export type AuditFilters = {
  actorType?: AuditActorType;
  actorId?: string;
  actionId?: string;
  riskTier?: AuditRiskTier;
  /** `false` narrows to refused attempts, which is the incident view. */
  ok?: boolean;
  from?: Date;
  to?: Date;
};

/**
 * An entity a change was about.
 *
 * Lifted from the diff rather than stored, because the diff is where actions
 * already record it and a second copy could disagree with the first.
 */
export type AuditEntity = { type: string; id: string };

export type OrgAuditEntry = {
  id: string;
  actor: {
    type: AuditActorType;
    id: string | null;
    /**
     * Resolved from the staff or token record. **Null when it cannot be
     * resolved**, which is a real outcome: a staff row deleted after the fact
     * leaves an id nobody can put a name to, and inventing one would be worse
     * than showing the raw id.
     */
    name: string | null;
    email: string | null;
  };
  action: string;
  riskTier: AuditRiskTier;
  ok: boolean;
  error: { code: string | null; message: string | null } | null;
  /**
   * The distinct entities the invocation touched. Usually one; a bulk action
   * touches many, and collapsing those to a single "entity" would misreport it.
   */
  entities: AuditEntity[];
  /** Field-level before/after, exactly as the action recorded it. */
  changes: DiffEntry[];
  ip: string | null;
  userAgent: string | null;
  undoable: boolean;
  undoneBy: string | null;
  undoOf: string | null;
  occurredAt: string;
};

/** One `action_invocations` row, as far as the mapping is concerned. */
export type AuditRow = {
  id: string;
  actionId: string;
  actorType: AuditActorType;
  actorId: string | null;
  riskTier: AuditRiskTier;
  diff: DiffEntry[];
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  undoable: boolean;
  undoneByInvocationId: string | null;
  undoOfInvocationId: string | null;
  occurredAt: Date;
};

/** A name and address for an actor, or nothing if it could not be resolved. */
export type ResolvedActor = { name: string | null; email: string | null };

/**
 * The key an actor resolves under.
 *
 * Typed as well as identified, because ids from different tables share a
 * namespace here — a token id and a user id are both `actorId`, and a bare id
 * as the key could put a token's label on a person's row.
 */
export function actorKey(actorType: string, actorId: string): string {
  return `${actorType}:${actorId}`;
}

/** The distinct `entity:entityId` pairs in a diff, in first-seen order. */
export function entitiesFromDiff(diff: DiffEntry[]): AuditEntity[] {
  const seen = new Set<string>();
  const out: AuditEntity[] = [];
  for (const d of diff) {
    const key = `${d.entity}:${d.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: d.entity, id: d.entityId });
  }
  return out;
}

/**
 * One row plus whatever names were resolved for it → one audit entry.
 *
 * Pure: every lookup has already happened, so this cannot go to the database
 * per row, which is what a page of 100 entries would otherwise do.
 */
export function toAuditEntry(
  row: AuditRow,
  names: Map<string, ResolvedActor>,
): OrgAuditEntry {
  const resolved = row.actorId ? names.get(actorKey(row.actorType, row.actorId)) : undefined;

  return {
    id: row.id,
    actor: {
      type: row.actorType,
      id: row.actorId,
      /**
       * `system` names itself — there is no record to resolve, and it is the
       * one actor whose identity is a role rather than a person.
       */
      name: row.actorType === "system" ? "Markii system" : (resolved?.name ?? null),
      email: resolved?.email ?? null,
    },
    action: row.actionId,
    riskTier: row.riskTier,
    ok: row.ok,
    /**
     * **Only ever populated on a failure.** A successful invocation carries no
     * error, and emitting an object of nulls would make every row look like it
     * had one field of an error recorded.
     */
    error: row.ok ? null : { code: row.errorCode, message: row.errorMessage },
    entities: entitiesFromDiff(row.diff),
    changes: row.diff,
    ip: row.ipAddress,
    userAgent: row.userAgent,
    undoable: row.undoable,
    undoneBy: row.undoneByInvocationId,
    undoOf: row.undoOfInvocationId,
    occurredAt: row.occurredAt.toISOString(),
  };
}
