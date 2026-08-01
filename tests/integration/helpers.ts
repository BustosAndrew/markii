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
  siteIdsForTaxSettings: number[] = [];
  merchantEmails: string[] = [];
  /** Restores `products.stock`, which the legacy non-variant path decrements. */
  productStock: { id: number; stock: number }[] = [];

  async run() {
    for (const id of this.usageRecordIds) await sql`delete from usage_records where id = ${id}`;
    for (const id of this.checkoutSessionIds) {
      await sql`delete from checkout_sessions where id = ${id}`;
    }
    for (const id of this.orderIds) await sql`delete from orders where id = ${id}`;
    for (const id of this.cartIds) await sql`delete from carts where id = ${id}`;
    for (const id of this.discountIds) await sql`delete from discounts where id = ${id}`;
    for (const id of this.shippingZoneIds) await sql`delete from shipping_zones where id = ${id}`;
    for (const id of this.siteIdsForTaxSettings) {
      await sql`delete from tax_settings where site_id = ${id}`;
    }
    for (const id of this.variantIds) {
      await sql`delete from inventory_ledger where variant_id = ${id}`;
      await sql`delete from variants where id = ${id}`;
    }
    for (const id of this.locationIds) await sql`delete from locations where id = ${id}`;
    for (const p of this.productStock) {
      await sql`update products set stock = ${p.stock} where id = ${p.id}`;
    }
    for (const email of this.merchantEmails) await removeMerchant(email);
  }
}

/** The seeded demo store the storefront tests run against. */
export async function demoStore(slug = "aurora-supply") {
  const [site] = await sql`select * from sites where slug = ${slug}`;
  if (!site) {
    throw new Error(`Seed store "${slug}" is missing. Run: pnpm db:seed`);
  }
  const products = await sql`select * from products
    where site_id = ${site.id} and enabled order by id limit 5`;
  if (products.length < 3) {
    throw new Error(`Seed store "${slug}" has too few products. Run: pnpm db:seed`);
  }
  return { site, products, slug };
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
