import "server-only";

import { and, eq } from "drizzle-orm";
import { db, staff } from "../db";
import { roleHasPermission } from "../auth/permissions";
import { setAuthorizationResolver } from "./registry";
import type { Actor } from "./types";

/**
 * The real authorization resolver (Phase A), replacing the deny-all default.
 *
 * §22 rule 4: identical permissions for humans, agents, and tokens. That is why
 * this resolves from the **staff record**, not from the actor object — an agent
 * acting on someone's behalf gets exactly that person's role, and a caller
 * cannot widen its own scope by asserting a different one.
 *
 * Import for side effect once, at the boundary that invokes actions.
 */
async function resolve(actor: Actor, permission: string): Promise<boolean> {
  // Migrations, seeds, cron. Never reachable over HTTP, so it is not a hole an
  // external caller can climb through.
  if (actor.type === "system") return true;

  if (!actor.orgId) return false;

  const userId =
    actor.type === "agent" ? actor.onBehalfOfUserId : actor.type === "user" ? actor.id : null;

  // Scoped tokens carry their own role rather than a user's (§16: "never a
  // user's session cookie"). Phase A does not issue them yet, so until the
  // token store exists the honest answer is no.
  if (userId === null) return false;

  const [member] = await db
    .select({ role: staff.role, status: staff.status })
    .from(staff)
    .where(and(eq(staff.userId, userId), eq(staff.orgId, actor.orgId)))
    .limit(1);

  // A disabled member keeps their row so history stays attributable, but must
  // authorize nothing.
  if (!member || member.status !== "active") return false;

  return roleHasPermission(member.role, permission);
}

setAuthorizationResolver(resolve);
