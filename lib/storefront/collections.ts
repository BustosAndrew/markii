import { and, asc, eq, isNotNull } from "drizzle-orm";
import { collections, db, type Collection, type Product } from "@/lib/db";
import { membersOf } from "@/lib/commerce/collection-queries";

/**
 * Collections as a storefront sees them (§18.2).
 *
 * Two filters the dashboard's own reads do not apply, and both are the point:
 * **published only** — `publishedAt` is the merchant's switch, and a draft
 * collection reaching a shopper or an agent would make the switch decoration —
 * and **enabled products only**, the same rule every other storefront surface
 * applies, so a disabled product cannot reappear through a collection it was
 * placed in before being hidden.
 */

export async function publishedCollectionsFor(siteId: number): Promise<Collection[]> {
  return db
    .select()
    .from(collections)
    .where(and(eq(collections.siteId, siteId), isNotNull(collections.publishedAt)))
    .orderBy(asc(collections.title));
}

export async function publishedCollectionByHandle(
  siteId: number,
  handle: string,
): Promise<Collection | null> {
  const [row] = await db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.siteId, siteId),
        eq(collections.handle, handle),
        isNotNull(collections.publishedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The products a shopper sees in a collection: `membersOf` — manual list or
 * evaluated rules, in the collection's own order — minus anything disabled.
 * Filtered after the fact rather than pushed into the rule SQL, so the one
 * place rules are evaluated stays shared with the dashboard's counts.
 */
export async function storefrontMembersOf(collection: Collection, limit = 200): Promise<Product[]> {
  const members = await membersOf(collection, limit, 0);
  return members.filter((p) => p.enabled);
}
