import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { apiTokens, db, staff } from "../db";
import { PLATFORM_PERMISSIONS, roleHasPermission } from "../auth/permissions";
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
  /**
   * Migrations, seeds, and the billing sweep.
   *
   * This used to be justified by "never reachable over HTTP". That stopped being
   * true when `/api/cron/billing` shipped, so the guarantee now rests on
   * `CRON_SECRET` instead: `lib/cron/auth.ts` is the only path from a request to
   * a system actor, and it refuses rather than defaulting open when the secret
   * is missing. Anything else that mints one is a full authorization bypass.
   */
  if (actor.type === "system") return true;

  /**
   * An operator holds the platform permissions and nothing else. The allowlist
   * was checked when the actor was minted (`requireOperator`), which is the
   * same trust the `system` branch places in `CRON_SECRET`: what may mint one
   * is the whole question, and nothing may but that one function. Denying
   * every merchant-scoped permission here is what keeps an operator from
   * editing a catalog through the door that exists to suspend a store.
   */
  if (actor.type === "operator") {
    return (PLATFORM_PERMISSIONS as readonly string[]).includes(permission);
  }

  if (!actor.orgId) return false;

  /**
   * Scoped tokens carry their own role rather than a user's (§16: "never a
   * user's session cookie"). A revoked token authorizes nothing, which is why
   * `revokedAt` is re-checked here and not only at request parse time.
   */
  if (actor.type === "token") {
    const [token] = await db
      .select({ role: apiTokens.role })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.id, actor.id),
          eq(apiTokens.orgId, actor.orgId),
          isNull(apiTokens.revokedAt),
        ),
      )
      .limit(1);
    return token ? roleHasPermission(token.role, permission) : false;
  }

  const userId = actor.type === "agent" ? actor.onBehalfOfUserId : actor.id;

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
