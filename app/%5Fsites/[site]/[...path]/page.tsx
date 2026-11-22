import { loadSite } from "@/lib/storefront";
import { redirectOrNotFound } from "@/lib/storefront/redirects";

type Props = { params: Promise<{ site: string; path: string[] }> };

/**
 * Every storefront path no other route claims — an old platform's
 * `/products/green-tea`, say. Nothing renders here: it is a redirect if the
 * store has one for this path, and the storefront's 404 otherwise. Static and
 * dynamic routes beside it always win, so it can never shadow a real page.
 */
export default async function UnclaimedPath({ params }: Props) {
  const { site: siteSlug, path } = await params;
  return redirectOrNotFound(await loadSite(siteSlug), `/${path.join("/")}`);
}
