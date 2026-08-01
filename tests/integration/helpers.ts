import postgres from "postgres";
import "./env";
import { BASE_URL } from "./setup";

/**
 * Shared plumbing for the integration suite.
 *
 * Tests talk to the app the way a shopper's browser or a merchant's dashboard
 * does — over HTTP, through the real routes — and inspect the result in the
 * database directly. Asserting through the same layer that wrote the value
 * would only prove the code agrees with itself.
 */

export const sql = postgres(process.env.DATABASE_URL!, { prepare: false });

export type ApiResult<T = any> = { status: number; json: T };

/** A cookie-carrying HTTP client. One instance per identity under test. */
export class Client {
  private cookie = "";

  async call<T = any>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length) {
      this.cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: res.status, json };
  }

  get = <T = any>(p: string) => this.call<T>("GET", p);
  post = <T = any>(p: string, b?: unknown) => this.call<T>("POST", p, b);
  patch = <T = any>(p: string, b?: unknown) => this.call<T>("PATCH", p, b);
  del = <T = any>(p: string) => this.call<T>("DELETE", p);

  /** Invoke a registry action (§22). `dryRun` returns the diff without writing. */
  invoke = <T = any>(id: string, input: unknown, opts?: { dryRun?: boolean }) =>
    this.post<T>(`/api/actions/${id}${opts?.dryRun ? "?dryRun=1" : ""}`, input);

  clearCookies() {
    this.cookie = "";
  }
}

/**
 * The registry refuses either with an HTTP 4xx or with an `ok: false` outcome
 * depending on where the failure happened. Callers care that it was refused.
 */
export function refused(r: ApiResult): boolean {
  return r.status >= 400 || r.json?.ok === false;
}

/**
 * Signs up a merchant, confirms their email, and signs them in.
 *
 * Email confirmation is on, so sign-up alone yields no session — the route
 * correctly reports `emailConfirmationRequired` rather than pretending. Tests
 * confirm directly in the database instead of going through the mail.
 */
export async function signUpMerchant(client: Client, label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // Supabase rejects `.test` and `example.com`; markii.shop is a real domain.
  const email = `test-${label}-${stamp}@markii.shop`;
  const password = `Tv!${stamp}aA9`;

  client.clearCookies();
  const up = await client.post("/api/auth/sign-up", { email, password });
  if (up.status >= 400) throw new Error(`sign-up failed: ${JSON.stringify(up.json)}`);

  await sql`update auth.users set email_confirmed_at = now() where email = ${email}`;

  client.clearCookies();
  const inn = await client.post("/api/auth/sign-in", { email, password });
  if (inn.status >= 400) throw new Error(`sign-in failed: ${JSON.stringify(inn.json)}`);

  return { email, password };
}

/** Removes a merchant and everything cascading from their org. */
export async function removeMerchant(email: string) {
  const users = await sql`select id from auth.users where email = ${email}`;
  for (const u of users) {
    await sql`delete from organizations where owner_id = ${u.id}`;
    await sql`delete from auth.users where id = ${u.id}`;
  }
}

/**
 * Tracks rows a test creates so it can put the database back.
 *
 * Deletion order matters and is fixed here rather than at each call site:
 * usage records and sessions reference orders, orders reference sites, and a
 * test that gets the order wrong leaves foreign-key debris behind.
 */
export class Cleanup {
  usageRecordIds: string[] = [];
  checkoutSessionIds: string[] = [];
  orderIds: number[] = [];
  cartIds: number[] = [];
  discountIds: number[] = [];
  shippingZoneIds: number[] = [];
  variantIds: number[] = [];
  locationIds: number[] = [];
  merchantEmails: string[] = [];
  /** Test-owned stores. Deleting the org cascades everything beneath it. */
  orgIds: string[] = [];
  siteIds: number[] = [];

  async run() {
    for (const id of this.usageRecordIds) await sql`delete from usage_records where id = ${id}`;
    for (const id of this.checkoutSessionIds) {
      await sql`delete from checkout_sessions where id = ${id}`;
    }
    for (const id of this.orderIds) await sql`delete from orders where id = ${id}`;
    for (const id of this.cartIds) await sql`delete from carts where id = ${id}`;
    for (const id of this.discountIds) await sql`delete from discounts where id = ${id}`;
    for (const id of this.shippingZoneIds) await sql`delete from shipping_zones where id = ${id}`;
    for (const id of this.variantIds) {
      await sql`delete from inventory_ledger where variant_id = ${id}`;
      await sql`delete from variants where id = ${id}`;
    }
    for (const id of this.locationIds) await sql`delete from locations where id = ${id}`;

    /**
     * The safety net, and the reason it is not just belt-and-braces: orders and
     * usage records reference a site with `on delete set null`, so dropping the
     * org would leave them behind pointing at nothing. Sweeping by site catches
     * anything an individual test forgot to track, which is the failure mode
     * that actually happened while writing these.
     */
    for (const id of this.siteIds) {
      await sql`delete from usage_records where site_id = ${id}`;
      await sql`delete from orders where site_id = ${id}`;
    }

    // Cascades to sites, products, carts, discounts, zones, tax settings.
    for (const id of this.orgIds) await sql`delete from organizations where id = ${id}`;

    for (const email of this.merchantEmails) await removeMerchant(email);
  }
}

/**
 * Creates a private store for one test file: its own org, site, and products.
 *
 * **Tests own their fixtures rather than borrowing the seeded demo store.** The
 * earlier version used `aurora-supply` and mutated it — disabling a product,
 * changing a price, rewriting tax settings — restoring each afterwards. That
 * works exactly once at a time: two concurrent runs (two CI jobs, or a re-run
 * overlapping the first) see each other's mutations, and the failures do not
 * reproduce. It also meant a crashed test left the demo store altered.
 *
 * A disposable store removes the shared state entirely, so the suite can run
 * anywhere, in parallel, against a database someone else is also using.
 *
 * Deleting the org cascades to the site and everything under it. Orders are the
 * exception — they reference a site with `on delete set null`, so they are
 * removed explicitly first (see {@link Cleanup.run}) or they survive as orphans.
 */
export async function createTestStore(
  cleanup: Cleanup,
  label: string,
  /**
   * Attach the store to an org that already exists — the one a signed-up
   * merchant owns. Without it the store belongs to a synthetic org with no
   * staff, which is fine for storefront tests but means no session can invoke
   * an action against it.
   */
  opts: { orgId?: string } = {},
) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const orgId = opts.orgId ?? `org_test_${stamp}`;
  const slug = `test-${label}-${stamp}`;

  if (!opts.orgId) {
    await sql`insert into organizations (id, name, slug, owner_id, billing_email, currency, country)
      values (${orgId}, ${`Test Org ${label}`}, ${`test-org-${stamp}`},
              ${`test-owner-${stamp}`}, ${`test-${stamp}@markii.shop`}, 'USD', 'US')`;
    // Only orgs this helper created are its to delete; a merchant's own org is
    // removed with the merchant.
    cleanup.orgIds.push(orgId);
  }

  const [site] = await sql`insert into sites
    (org_id, name, slug, status, purchases_enabled, wallet_address, payment_providers)
    values (${orgId}, ${`Test Store ${label}`}, ${slug}, 'live', true,
            '0xtestwallet000000000000000000000000000001',
            ${sql.json({ x402: true, stripe: false })})
    returning *`;
  cleanup.siteIds.push(site.id);

  // Three products at distinct prices, so a test can tell which one a
  // product-scoped discount or a per-line assertion actually hit.
  const specs = [
    { name: "Test Product One", slug: "test-product-one", priceCents: 1400, stock: 60 },
    { name: "Test Product Two", slug: "test-product-two", priceCents: 1900, stock: 55 },
    { name: "Test Product Three", slug: "test-product-three", priceCents: 3800, stock: 90 },
  ];
  const products = [];
  for (const s of specs) {
    const [p] = await sql`insert into products
      (site_id, name, slug, price_cents, currency, stock, enabled)
      values (${site.id}, ${s.name}, ${s.slug}, ${s.priceCents}, 'USD', ${s.stock}, true)
      returning *`;
    products.push(p);
  }

  return { site, products, slug, orgId };
}

/** Records a cart by token so cleanup can find it. */
export async function trackCart(cleanup: Cleanup, token: string) {
  const [row] = await sql`select id from carts where token = ${token}`;
  if (row) cleanup.cartIds.push(row.id);
  return row?.id as number | undefined;
}

/**
 * Records everything an order pulled into existence, working backwards from it.
 *
 * The x402 one-shot builds its own cart and checkout session *inside the route*
 * — a test never sees their ids, so it cannot track them the usual way. Walking
 * back from the order finds them, and is worth using after any completion:
 * missing a session leaves a cart behind, and missing a usage record leaves a
 * metering row pointing at a deleted order.
 */
export async function trackOrderCascade(cleanup: Cleanup, orderId: number) {
  cleanup.orderIds.push(orderId);

  const usage = await sql`select id from usage_records where order_id = ${orderId}`;
  cleanup.usageRecordIds.push(...usage.map((u) => u.id as string));

  const sessions = await sql`select id, cart_id from checkout_sessions where order_id = ${orderId}`;
  for (const s of sessions) {
    cleanup.checkoutSessionIds.push(s.id as string);
    if (s.cart_id != null) cleanup.cartIds.push(s.cart_id as number);
  }
}
