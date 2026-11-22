import "server-only";

import { and, eq } from "drizzle-orm";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { db, siteRedirects } from "@/lib/db";
import { storefrontHalted, type SiteData } from "@/lib/storefront";
import { normalizeRedirectPath, resolveRedirectTarget } from "./redirect-rules";

/**
 * Storefront redirects at the one moment they apply: when the storefront is
 * about to answer 404. Every storefront route that would call `notFound()` for
 * a missing product, category, collection or page calls this instead, and the
 * catch-all route sends every path no route claims here too — so a redirect
 * never shadows something that exists, and costs one indexed read only on a
 * miss.
 */

export async function findRedirect(siteId: number, path: string) {
  let from: string;
  try {
    from = normalizeRedirectPath(path);
  } catch {
    return null;
  }
  const [row] = await db
    .select({ toUrl: siteRedirects.toUrl, permanent: siteRedirects.permanent })
    .from(siteRedirects)
    .where(and(eq(siteRedirects.siteId, siteId), eq(siteRedirects.fromPath, from)))
    .limit(1);
  return row ?? null;
}

/**
 * Redirect if the store has a rule for `path`, otherwise 404. Never in the
 * builder preview — a draft preview must not send the merchant off to the live
 * store or another site — and never for a halted store, which answers as
 * unavailable whatever was asked for.
 */
export async function redirectOrNotFound(data: SiteData | null, path: string): Promise<never> {
  if (data && !data.preview && !storefrontHalted(data)) {
    const hit = await findRedirect(data.site.id, path);
    if (hit) {
      const to = resolveRedirectTarget(hit.toUrl, data.baseUrl);
      if (hit.permanent) permanentRedirect(to);
      redirect(to);
    }
  }
  notFound();
}
