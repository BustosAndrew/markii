import "server-only";

import { errorResponse, forbidden } from "../api";
import { roleHasPermission } from "./permissions";
import { requireAuthContext, type AuthContext } from "./session";

type RouteCtx = { params: Promise<Record<string, string>> };

export type OrgRouteCtx = RouteCtx & {
  /** Caller identity and scope — a signed-in human, or a scoped API/MCP token. */
  session: AuthContext;
  /** Convenience: the only value most routes need. */
  orgId: string;
};

/**
 * Wraps a route handler so it **cannot run without a caller**, and receives that
 * caller's org already resolved.
 *
 * This is the other half of `lib/tenancy.ts`: those helpers make an unscoped
 * query hard to write, and this makes an unauthenticated route hard to write. A
 * handler that forgets to authenticate does not compile, because `orgId` only
 * exists on the context this provides.
 *
 * `orgId` is **never** read from the request (§16: "never accept `orgId` from
 * the client") — only from the session cookie or the token's own record.
 *
 * Permission checks are identical for humans, agents, and tokens (§22 rule 4).
 */
/**
 * **Omitting `permission` authorizes every role, including `viewer`.** There is
 * no default and there deliberately is not one — a default that guessed would
 * be wrong for the read routes, and a default that denied would break them.
 *
 * That made it a silent hole for the whole §1–8 REST surface, which predates
 * roles: `PATCH /api/sites/:id` accepted `walletAddress` — the x402 payout
 * destination — with no check at all, reopening through a second route the
 * exact hole `PUT /api/integrations/:provider` had been converted to actions to
 * close. Every write route was gated on 2026-08-11.
 *
 * **Only three write routes may legitimately omit it**: `actions/[id]`,
 * `actions/[id]/undo`, and `integrations/[provider]`, which pass their work to
 * `invokeAction` and are authorized there against the action's own permission
 * (§22 rule 4). Undo is on the list for the same reason as the other two and no
 * other — it invokes an action, so the inverse's own permission and step-up are
 * what gate it. Anywhere else, a missing `permission` on a mutating handler is
 * a bug.
 */
export function orgHandler(
  fn: (req: Request, ctx: OrgRouteCtx) => Promise<Response>,
  options: { permission?: string } = {},
) {
  return async (req: Request, ctx: RouteCtx): Promise<Response> => {
    try {
      const session = await requireAuthContext(req);

      if (options.permission && !roleHasPermission(session.role, options.permission)) {
        throw forbidden(`Your role (${session.role}) cannot ${options.permission}`);
      }

      return await fn(req, { ...ctx, session, orgId: session.org.id });
    } catch (e) {
      return errorResponse(e);
    }
  };
}
