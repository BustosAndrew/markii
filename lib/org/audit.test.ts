import { describe, expect, it } from "vitest";
import type { DiffEntry } from "../db";
import {
  actorKey,
  entitiesFromDiff,
  toAuditEntry,
  type AuditRow,
  type ResolvedActor,
} from "./audit";

const AT = new Date("2026-09-06T12:00:00.000Z");

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: "inv_1",
    actionId: "catalog.updateProduct",
    actorType: "user",
    actorId: "usr_1",
    riskTier: "medium",
    diff: [],
    ok: true,
    errorCode: null,
    errorMessage: null,
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    undoable: true,
    undoneByInvocationId: null,
    undoOfInvocationId: null,
    occurredAt: AT,
    ...over,
  };
}

function diff(over: Partial<DiffEntry> = {}): DiffEntry {
  return { entity: "product", entityId: "1", path: "title", before: "a", after: "b", ...over };
}

const names = new Map<string, ResolvedActor>([
  ["user:usr_1", { name: "Ada", email: "ada@example.com" }],
  ["token:tok_1", { name: "CI deploy key", email: null }],
]);

describe("entitiesFromDiff", () => {
  it("is empty for an action that recorded no diff", () => {
    expect(entitiesFromDiff([])).toEqual([]);
  });

  it("collapses many field changes on one entity to a single entry", () => {
    const entities = entitiesFromDiff([
      diff({ path: "title" }),
      diff({ path: "priceMinor" }),
      diff({ path: "status" }),
    ]);
    expect(entities).toEqual([{ type: "product", id: "1" }]);
  });

  /**
   * A bulk action touches many rows, and reporting only the first would make
   * the log understate what happened — the opposite of what it is for.
   */
  it("keeps every distinct entity, in first-seen order", () => {
    const entities = entitiesFromDiff([
      diff({ entityId: "2" }),
      diff({ entityId: "1" }),
      diff({ entityId: "2", path: "status" }),
      diff({ entity: "variant", entityId: "1" }),
    ]);
    expect(entities).toEqual([
      { type: "product", id: "2" },
      { type: "product", id: "1" },
      { type: "variant", id: "1" },
    ]);
  });

  /** Same id under two entity types is two entities, not one. */
  it("does not confuse equal ids across different entity types", () => {
    expect(entitiesFromDiff([diff({ entity: "product" }), diff({ entity: "order" })])).toEqual([
      { type: "product", id: "1" },
      { type: "order", id: "1" },
    ]);
  });
});

describe("actorKey", () => {
  it("namespaces by type, so a token id cannot collide with a user id", () => {
    expect(actorKey("user", "x")).not.toBe(actorKey("token", "x"));
  });
});

describe("toAuditEntry", () => {
  it("resolves a staff actor to their name and email", () => {
    const entry = toAuditEntry(row(), names);
    expect(entry.actor).toEqual({
      type: "user",
      id: "usr_1",
      name: "Ada",
      email: "ada@example.com",
    });
  });

  it("resolves a token actor to its label", () => {
    const entry = toAuditEntry(row({ actorType: "token", actorId: "tok_1" }), names);
    expect(entry.actor.name).toBe("CI deploy key");
    expect(entry.actor.email).toBeNull();
  });

  /**
   * An agent's `actorId` is the person it acts for, so it resolves through the
   * same staff record rather than showing an unattributable id.
   */
  it("resolves an agent through the person it acts for", () => {
    const withAgent = new Map(names);
    withAgent.set("agent:usr_1", { name: "Ada", email: "ada@example.com" });
    const entry = toAuditEntry(row({ actorType: "agent" }), withAgent);
    expect(entry.actor.name).toBe("Ada");
  });

  /**
   * The whole point of a null name: a staff row deleted after the fact leaves
   * an id nobody can put a name to, and a placeholder would be a fabrication.
   */
  it("leaves the name null when the actor can no longer be resolved", () => {
    const entry = toAuditEntry(row({ actorId: "usr_gone" }), names);
    expect(entry.actor.name).toBeNull();
    expect(entry.actor.id).toBe("usr_gone");
  });

  it("names the system actor without a lookup", () => {
    const entry = toAuditEntry(row({ actorType: "system", actorId: "cron" }), new Map());
    expect(entry.actor.name).toBe("Markii system");
  });

  it("carries no error object on a successful invocation", () => {
    expect(toAuditEntry(row(), names).error).toBeNull();
  });

  /** "Who tried what and was refused" is the half that matters in an incident. */
  it("reports the code and message of a refused attempt", () => {
    const entry = toAuditEntry(
      row({ ok: false, errorCode: "FORBIDDEN", errorMessage: "Missing permission" }),
      names,
    );
    expect(entry.ok).toBe(false);
    expect(entry.error).toEqual({ code: "FORBIDDEN", message: "Missing permission" });
  });

  /**
   * Null is a real answer here — a non-HTTP caller has no address — so it must
   * survive the mapping rather than becoming a placeholder.
   */
  it("passes a missing origin through as null", () => {
    const entry = toAuditEntry(row({ ipAddress: null, userAgent: null }), names);
    expect(entry.ip).toBeNull();
    expect(entry.userAgent).toBeNull();
  });

  it("reports the origin when there is one", () => {
    const entry = toAuditEntry(row(), names);
    expect(entry.ip).toBe("203.0.113.7");
    expect(entry.userAgent).toBe("Mozilla/5.0");
  });

  it("carries both directions of the undo link", () => {
    const entry = toAuditEntry(
      row({ undoneByInvocationId: "inv_9", undoOfInvocationId: "inv_0" }),
      names,
    );
    expect(entry.undoneBy).toBe("inv_9");
    expect(entry.undoOf).toBe("inv_0");
  });

  it("serializes the timestamp as ISO", () => {
    expect(toAuditEntry(row(), names).occurredAt).toBe("2026-09-06T12:00:00.000Z");
  });

  it("keeps the full field-level diff alongside the entity summary", () => {
    const changes = [diff({ path: "title" }), diff({ path: "status" })];
    const entry = toAuditEntry(row({ diff: changes }), names);
    expect(entry.changes).toEqual(changes);
    expect(entry.entities).toEqual([{ type: "product", id: "1" }]);
  });
});
