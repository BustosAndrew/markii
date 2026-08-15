import { eq, ne, and } from "drizzle-orm";
import { NextResponse } from "next/server";
import { conflict } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { invalidateCustomDomain } from "@/lib/domains";
import {
  attachTenantHost,
  detachTenantHost,
  unregisterDomain,
} from "@/lib/domains/platform";
import { resolveSite, serializeSite } from "@/lib/queries";
import { assertNoRedirectedSiteFields, siteUpdateSchema } from "@/lib/validation";

export const GET = orgHandler(async (_req, { params, orgId }) => {
  const { idOrSlug } = await params;
  const site = await resolveSite(idOrSlug, orgId);
  return NextResponse.json(await serializeSite(site));
});

export const PATCH = orgHandler(
  async (req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const body = await req.json();
    // Refused by name, not stripped — see SITE_FIELDS_ELSEWHERE.
    assertNoRedirectedSiteFields(body);
    const input = siteUpdateSchema.parse(body);

    if (input.slug && input.slug !== site.slug) {
      const [taken] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.slug, input.slug), ne(sites.id, site.id)))
        .limit(1);
      if (taken) throw conflict(`site slug "${input.slug}" is already taken`);
    }

    const [row] = await db
      .update(sites)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(sites.id, site.id))
      .returning();

    /**
     * A slug **is** the storefront's address, so renaming one moves the host it
     * answers on. The old `{slug}.{ROOT_DOMAIN}` has to be released and the new
     * one attached, or the store becomes unreachable at its new name while the
     * old name keeps a project domain slot forever — the same orphan the custom
     * domain paths had.
     *
     * Also covers a storefront going live through this route rather than
     * `/deploy`, which is a second real entry point to the same state.
     *
     * Failures are logged, not thrown: the rename itself committed, and turning
     * a successful write into an error would be worse than a hostname that a
     * re-deploy can reattach.
     */
    const slugChanged = row.slug !== site.slug;
    const wentLive = row.status === "live" && site.status !== "live";

    if (slugChanged) {
      const detached = await detachTenantHost(site.slug);
      if (!detached.ok) {
        console.error(`tenant host detach failed for old slug ${site.slug}: ${detached.message}`);
      }
    }
    if (row.status === "live" && (slugChanged || wentLive)) {
      const attached = await attachTenantHost(row.slug);
      if (!attached.ok) {
        console.error(`tenant host attach failed for ${row.slug}: ${attached.message}`);
      }
    }

    return NextResponse.json(await serializeSite(row));
  },
  /**
   * Matches `POST /api/sites`, which has always required this. Editing a
   * storefront — whether it takes payments at all — is the same authority as
   * creating one, and this route carried **no** permission until 2026-08-11, so
   * every role including `viewer` could do it.
   *
   * The custom domain is no longer among the fields it can write: it needs proof
   * of ownership, which a field assignment cannot express (`domains.*`, §2).
   */
  { permission: "cms.write" },
);

export const DELETE = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    // categories/products/traffic cascade; orders keep a nulled site reference
    await db.delete(sites).where(eq(sites.id, site.id));
    invalidateCustomDomain(site.customDomain);

    /**
     * Deleting the storefront must release its domain from the hosting platform
     * too (§2 step two). The row that named the hostname is gone, so nothing
     * after this point could ever know to detach it — the domain would stay
     * bound to Markii's Vercel project forever, consuming its allowance and
     * blocking the merchant from attaching that hostname anywhere else.
     *
     * After the delete, not before: detaching a domain for a storefront that
     * then failed to delete would take a live store offline. Only verified
     * domains are ever registered, so only those are detached, and a failure is
     * logged rather than thrown — the deletion itself already succeeded and
     * reporting it as failed would be worse than a stranded domain.
     */
    if (site.domainStatus === "verified" && site.customDomain) {
      const platform = await unregisterDomain(site.customDomain);
      if (!platform.ok) {
        console.error(
          `domain detach failed for deleted site ${site.id} (${site.customDomain}): ${platform.message}`,
        );
      }
    }

    /**
     * The storefront's own `{slug}.{ROOT_DOMAIN}` goes the same way, and for the
     * same reason: the row naming it is gone, so nothing afterwards could
     * release it. Unlike a custom domain this one is only ever Markii's own
     * namespace, but it still occupies a project domain slot indefinitely.
     */
    const tenant = await detachTenantHost(site.slug);
    if (!tenant.ok) {
      console.error(`tenant host detach failed for deleted site ${site.slug}: ${tenant.message}`);
    }

    return NextResponse.json({ deleted: true, id: site.id });
  },
  /** Deleting a storefront cascades its catalog. Read-only roles could do this. */
  { permission: "cms.write" },
);
