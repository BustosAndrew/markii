import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
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
 */
export const GET = handler(async () => {
  const { user, org, role } = await requireSession();
  const entitlements = entitlementsFor(org);

  // Every org this user belongs to, so the dashboard can render a switcher
  // without a second call. `POST /api/org/switch` changes the active one.
  const memberships = await listMemberships(user.id);

  return NextResponse.json({
    user,
    org: serializeOrg(org),
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
