import "server-only";

import { errorResponse, forbidden } from "../api";
import { assertAccountStanding } from "../billing/standing-guard";
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

      /**
       * Account standing (D45), for the **§1-8 routes that mutate outside the
       * registry**.
       *
       * `invokeAction` already holds every action, and §22 rule 1 says that
       * should be every mutation — but the v1 catalog, category, site, upload
       * and import routes predate that rule and still write directly. Gating
       * only the registry left an expired merchant able to create products and
       * storefronts through the older surface, the same shape of hole that
       * `PUT /api/integrations/:provider` turned out to be.
       *
       * **Keyed on the HTTP method, not a permission**, because the permission
       * strings carry no reliable read/write split — and the method is exactly
       * the question being asked: `GET` is a read, and reads are never held.
       */
      if (req.method !== "GET" && req.method !== "HEAD") {
        const path = new URL(req.url).pathname;
        /**
         * Two exemptions, and the second one is not optional.
         *
         * `/api/billing/` — "subscribe to reinstate everything" cannot itself
         * require standing, or the merchant is locked out of the only door.
         *
         * `/api/actions/` and `/api/integrations/` **delegate to
         * `invokeAction`**, which runs this same check one layer down where it
         * can see the action id and exempt `billing.*` precisely. Gating them
         * here as well would refuse `POST /api/actions/billing.setCancellation`
         * — a billing action that does not live under the billing path — and
         * shut that door after all. Checking twice with less information than
         * the inner check is strictly worse than not checking here at all.
         */
        const delegatesToRegistry =
          path.startsWith("/api/actions/") || path.startsWith("/api/integrations/");

        /**
         * **Account administration is never held behind payment.**
         *
         * `/api/org/` carries staff removal and API-token revocation. Gating
         * those would mean a merchant whose trial lapsed cannot revoke a leaked
         * token or cut off a departing employee — turning an unpaid invoice into
         * a security incident they are forbidden to contain. It also covers the
         * org profile, which is where the address invoices are sent to is fixed.
         *
         * Withholding a storefront is a commercial measure; withholding the
         * ability to secure the account is not one Markii should ever take.
         */
        const accountAdministration = path.startsWith("/api/org");

        if (
          !path.startsWith("/api/billing/") &&
          !delegatesToRegistry &&
          !accountAdministration
        ) {
          await assertAccountStanding(session.org.id, `${req.method} ${path}`);
        }
      }

      return await fn(req, { ...ctx, session, orgId: session.org.id });
    } catch (e) {
      return errorResponse(e);
    }
  };
}
