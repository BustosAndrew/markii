import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { db, sites } from "@/lib/db";
import { attachTenantHost, isPlatformConfigured } from "@/lib/domains/platform";
import { resolveSite, storefrontUrl } from "@/lib/queries";

/**
 * `POST /api/sites/:idOrSlug/deploy` (§2) — publish a storefront.
 *
 * **Publishing is also when the storefront's own hostname is attached to the
 * hosting platform.** `{slug}.{ROOT_DOMAIN}` resolves through a wildcard DNS
 * record, but Vercel still rejects a hostname that is not registered to the
 * project — before `proxy.ts` runs — and issues no certificate for it. Without
 * this call the response would hand back a `storefrontUrl` that fails TLS.
 *
 * Done here rather than at creation because a draft is not meant to be
 * reachable, and every registration spends one of the project's domain slots.
 */
export const POST = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const [row] = await db
      .update(sites)
      .set({ status: "live", updatedAt: new Date() })
      .where(eq(sites.id, site.id))
      .returning();

    /**
     * Attempted after the status write, and its outcome is **reported rather
     * than swallowed**. The store really is published either way, so failing
     * the request would be a lie in the other direction — but returning a
     * `storefrontUrl` while silently knowing it does not answer is exactly the
     * fabricated-success this codebase refuses. `hostAttached: false` is what
     * lets a screen say "published, not reachable yet" instead of guessing.
     */
    const attach = await attachTenantHost(row.slug);

    return NextResponse.json({
      status: row.status,
      storefrontUrl: storefrontUrl(row),
      hostAttached: attach.ok,
      hostProblem: attach.ok
        ? null
        : isPlatformConfigured()
          ? attach.message
          : "Markii has not finished connecting its hosting platform, so this address is not " +
            "reachable yet. Nothing for you to do.",
    });
  },
  // Publishing a storefront is a write, and not one a viewer or analyst should make.
  { permission: "cms.write" },
);
