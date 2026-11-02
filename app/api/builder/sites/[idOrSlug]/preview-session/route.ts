import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { createPreviewSession } from "@/lib/builder/preview";
import { resolveSite } from "@/lib/queries";

/**
 * Mint a live-preview session for the editor's preview frame (D51, M2) — a
 * two-hour token that lets the storefront renderer show this site's **draft**.
 *
 * **A route handler, not a registry action**, for the reason API tokens are
 * one (`/api/org/tokens`): the result is a credential, and an action's result
 * is written to the audit log. It changes nothing a shopper or another staff
 * member sees, and holds no permission beyond reading the draft — the same
 * `cms.read` this route asks for.
 */
export const POST = orgHandler(
  async (_req, { params, orgId, session }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const created = await createPreviewSession({ siteId: site.id, slug: site.slug, userId: session.actor.id });
    return NextResponse.json(created, { status: 201, headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
