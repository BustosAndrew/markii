import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { db, storefrontKeys } from "@/lib/db";
import { resolveSite } from "@/lib/queries";

/**
 * `GET /api/sites/:idOrSlug/storefront-keys` (D53) — the store's storefront
 * secret keys, revoked ones included so a list explains the audit log.
 *
 * Never the key itself: only its hash is stored, and the `prefix` identifies a
 * key without authenticating it. Mutations are actions — `storefront.createKey`
 * (high, step-up; the only time the plaintext exists) and `storefront.revokeKey`.
 */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const rows = await db
      .select()
      .from(storefrontKeys)
      .where(eq(storefrontKeys.siteId, site.id))
      .orderBy(asc(storefrontKeys.id));
    return NextResponse.json({
      siteId: site.id,
      keys: rows.map((k) => ({
        id: k.id,
        label: k.label,
        prefix: k.prefix,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
      })),
    });
  },
  { permission: "tokens.manage" },
);
