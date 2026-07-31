import "server-only";

import { errorResponse, forbidden } from "../api";
import { roleHasPermission } from "./permissions";
import { requireSession, type Session } from "./session";

type RouteCtx = { params: Promise<Record<string, string>> };

export type OrgRouteCtx = RouteCtx & {
  session: Session;
  /** Convenience: the only value most routes need from the session. */
  orgId: string;
};

/**
 * Wraps a route handler so it **cannot run without a session**, and receives the
 * caller's org already resolved.
 *
 * This is the other half of `lib/tenancy.ts`: the helpers there make an
 * unscoped query hard to write, and this makes an unauthenticated route hard to
 * write. A handler that forgets to call `requireSession` does not compile,
 * because `orgId` only exists on the context this provides.
 *
 * `orgId` is **never** read from the request (§16: "never accept `orgId` from
 * the client") — only from the session cookie.
 */
export function orgHandler(
  fn: (req: Request, ctx: OrgRouteCtx) => Promise<Response>,
  options: { permission?: string } = {},
) {
  return async (req: Request, ctx: RouteCtx): Promise<Response> => {
    try {
      const session = await requireSession();

      if (options.permission && !roleHasPermission(session.role, options.permission)) {
        throw forbidden(`Your role (${session.role}) cannot ${options.permission}`);
      }

      return await fn(req, { ...ctx, session, orgId: session.org.id });
    } catch (e) {
      return errorResponse(e);
    }
  };
}
