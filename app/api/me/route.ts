import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { accountStanding } from "@/lib/billing/standing";
import { serializeOrg } from "@/lib/auth/serialize";
import { listMemberships, requireSession } from "@/lib/auth/session";
import { entitlementsFor } from "@/lib/plans";

/**
 * `GET /api/me` — the shape the dashboard boots from, and the **only** way a
 * screen learns who the user is (§16). Never read identity from a client-side
 * session; under D30 the browser could not read one anyway.
 *
 * `401` is not an error state for the dashboard — it means "redirect to
 * sign-in".
 *
 * **Cookie-only, deliberately: this route answers `401` to every API token.**
 * It calls `requireSession()` rather than `requireAuthContext`, and the response
 * shape is why — a `user`, the `organizations` they may switch between, and the
 * role active in this browser. A token has no user and no switcher, so there is
 * nothing coherent to return; `GET /api/org` is the token-facing equivalent and
 * carries the plan, entitlements and currency a programmatic caller needs.
 *
 * Worth stating because it has been rediscovered three times — by the org audit
 * log's permission probe, by the MCP `read_store` tool, and by an MFA test that
 * had been silently passing without ever reaching it. Pinned by
 * `tests/integration/mfa.test.ts`.
 */
export const GET = handler(async () => {
  const { user, org, role } = await requireSession();
  const entitlements = entitlementsFor(org);
  /**
   * Account standing rides on `/api/me` rather than the billing endpoint
   * because the dashboard layout already calls this once per page load, and the
   * banner has to render on **every** page — a merchant must not be able to work
   * for a week without meeting the fact that their free month is ending.
   *
   * Putting it on `GET /api/billing/subscription` instead would have cost a live
   * Stripe call for the payment method on every dashboard page. This is derived
   * from the org row already in hand.
   */
  const standing = accountStanding(org);

  // Every org this user belongs to, so the dashboard can render a switcher
  // without a second call. `POST /api/org/switch` changes the active one.
  const memberships = await listMemberships(user.id);

  return NextResponse.json({
    user,
    org: serializeOrg(org),
    standing:
      standing.state === "trialing"
        ? {
            state: standing.state,
            message: standing.reason,
            endsAt: standing.endsAt.toISOString(),
            daysLeft: standing.daysLeft,
          }
        : standing.state === "expired"
          ? { state: standing.state, message: standing.reason, endedAt: standing.endedAt.toISOString() }
          : { state: standing.state, message: standing.reason },
    role,
    organizations: memberships.map((m) => ({
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      role: m.staff.role,
      active: m.org.id === org.id,
    })),
    // Mirrors org.entitlements, as §16 pins the shape. Same object, so the two
    // cannot disagree.
    entitlements,
  });
});
