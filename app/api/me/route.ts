import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { serializeOrg } from "@/lib/auth/serialize";
import { requireSession } from "@/lib/auth/session";
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

  return NextResponse.json({
    user,
    org: serializeOrg(org),
    role,
    // Mirrors org.entitlements, as §16 pins the shape. Same object, so the two
    // cannot disagree.
    entitlements,
  });
});
