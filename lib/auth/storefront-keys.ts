import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { badRequest, forbidden, unauthorized } from "../api";
import { customers, db, storefrontKeys, type Customer } from "../db";
import { hashStorefrontKey, shopperEmailFrom, storefrontKeyFrom } from "./storefront-key-format";

/**
 * Who a storefront request is for, when an exported store's **server** is
 * asking (D53) — the other way, besides a Markii shopper session, that
 * `currentCustomer()` learns a shopper.
 *
 * - `none`: no storefront key on the request. Everything is as it always was.
 * - `server`: a valid key for **this** store. `customer` is the store's
 *   `customers` row for the asserted email (created on first sight, like a guest
 *   checkout's), or null when the server named no shopper.
 *
 * **The trust is the merchant's, for the merchant's own store.** Markii takes
 * the owner's server at its word about which of their customers is signed in —
 * the same customers the merchant already sees, grants memberships to and
 * refunds from the dashboard. A key opens one store's shopper routes and
 * nothing else; it is never a staff credential.
 *
 * **A key is refused, not ignored, when it is wrong** (`401`): an export that
 * silently fell back to guest would sell a member a locked-out checkout and
 * call it working. And **a key arriving from a browser is refused** (`403`):
 * a server's `fetch` sends no `Origin`, so one that does means the key is in
 * client code, where every shopper can read it and act as any customer.
 */
export type Delegation = { kind: "none" } | { kind: "server"; customer: Customer | null };

/** Refresh `lastUsedAt` at most this often — a write per request would buy nothing. */
const LAST_USED_GRANULARITY_MS = 60_000;

async function requestHeaders(): Promise<Headers | null> {
  try {
    const { headers } = await import("next/headers");
    return await headers();
  } catch {
    // Outside a request (order completion run from a webhook, a script): no delegation.
    return null;
  }
}

export async function storefrontDelegation(siteId: number): Promise<Delegation> {
  const h = await requestHeaders();
  const key = h ? storefrontKeyFrom(h) : null;
  if (!h || !key) return { kind: "none" };

  if (h.get("origin")) {
    throw forbidden(
      "A storefront secret key is for your server, and this one was sent from a browser. Anyone " +
        "visiting the store can read it there — revoke it and create another.",
    );
  }

  const [row] = await db
    .select({ id: storefrontKeys.id, lastUsedAt: storefrontKeys.lastUsedAt })
    .from(storefrontKeys)
    .where(
      and(
        eq(storefrontKeys.keyHash, hashStorefrontKey(key)),
        eq(storefrontKeys.siteId, siteId),
        isNull(storefrontKeys.revokedAt),
      ),
    )
    .limit(1);
  // One answer for unknown, revoked and another store's key — none says which.
  if (!row) throw unauthorized("That storefront key is not valid for this store");

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
    await db.update(storefrontKeys).set({ lastUsedAt: new Date() }).where(eq(storefrontKeys.id, row.id));
  }

  const asserted = shopperEmailFrom(h);
  if ("invalid" in asserted) throw badRequest("Markii-Shopper-Email is not an email address");
  if (asserted.email === null) return { kind: "server", customer: null };
  return { kind: "server", customer: await customerByEmail(siteId, asserted.email) };
}

/**
 * The store's customer for an address, created if this is the first time the
 * store has seen it. The unique `(siteId, email)` index decides a race; the
 * loser reads the winner's row. `authUserId` is left alone — this identity is
 * the owner's sign-in, not a Markii shopper account.
 */
async function customerByEmail(siteId: number, email: string): Promise<Customer | null> {
  const [created] = await db.insert(customers).values({ siteId, email }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.siteId, siteId), eq(customers.email, email)))
    .limit(1);
  return existing ?? null;
}
