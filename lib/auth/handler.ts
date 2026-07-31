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
