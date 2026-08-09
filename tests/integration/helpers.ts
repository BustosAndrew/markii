import { createHmac } from "node:crypto";
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

  /**
   * Multipart upload, carrying the same session cookie.
   *
   * Separate from {@link call} because `FormData` must set its own
   * `content-type` with the boundary — forcing `application/json` there
   * produces a body the server cannot parse.
   */
  async postForm<T = any>(path: string, form: FormData): Promise<ApiResult<T>> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: this.cookie ? { cookie: this.cookie } : {},
      body: form,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: res.status, json };
  }

  /**
   * A response whose body is not JSON and whose headers are the point — a CSV
   * export, `llms.txt`, `sitemap.xml`. {@link call} would swallow both: it
   * truncates an unparseable body to 500 characters and drops the headers, so a
   * test could not tell an attachment from a rendered page.
   */
  async getRaw(path: string): Promise<{ status: number; headers: Headers; text: string }> {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  get = <T = any>(p: string) => this.call<T>("GET", p);
  post = <T = any>(p: string, b?: unknown) => this.call<T>("POST", p, b);
  patch = <T = any>(p: string, b?: unknown) => this.call<T>("PATCH", p, b);
  put = <T = any>(p: string, b?: unknown) => this.call<T>("PUT", p, b);
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
 * Creates a confirmed staff user **without sending any email**.
 *
 * Supabase applies an auth email rate limit per project, and the suite creates a
 * merchant in `beforeAll` of every test file — so going through the public
 * sign-up route meant one run could exhaust the quota and the *next* run failed
 * in setup with `over_email_send_rate_limit`, which looks nothing like a rate
 * limit from the test output. Every file paid the cost of exercising sign-up,
 * and none of them was testing sign-up.
 *
 * The admin API creates the user already confirmed and sends nothing.
 * `app_metadata.user_kind` is stamped here for the same reason the sign-up route
 * stamps it rather than trusting `user_metadata` (D32): it is service-role only,
 * and it is the copy `isStaffUser()` reads. A fixture user without it would be
 * refused by every authorised route, which is not the thing under test.
 *
 * **The real sign-up route still has coverage** — see the sign-up test in
 * `tenancy.test.ts`, which is where that behaviour belongs.
 */
async function createConfirmedStaffUser(email: string, password: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Integration tests need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to create " +
        "fixture users without sending mail.",
    );
  }

  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      /** Already confirmed, so no confirmation mail is generated at all. */
      email_confirm: true,
      app_metadata: { user_kind: "staff" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`admin user creation failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * Creates a merchant and signs them in.
 *
 * The org is provisioned by `ensureFirstOrg`, which **sign-in** calls as well as
 * sign-up — so creating the user out of band loses nothing.
 */
/**
 * RFC 4648 base32 decode, for the TOTP secret Supabase hands back at enrolment.
 *
 * Written here rather than pulled in as a dependency: it is fifteen lines, and
 * the suite should not gain a package to do what an authenticator app does.
 */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A real TOTP code (RFC 6238), so the suite exercises the **actual** MFA path.
 *
 * D40 makes MFA mandatory for every merchant, which means every one of these
 * test files now depends on it working. The tempting shortcut is an env flag
 * that skips enforcement in tests — and that would leave the single control
 * standing between an attacker and every merchant's store completely untested.
 * Computing a code is thirty lines; not testing the login path is not worth it.
 */
export function totpCode(secret: string, at: Date = new Date()): string {
  const counter = Math.floor(at.getTime() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/**
 * Enrols a factor and clears the challenge, leaving the session at `aal2`.
 *
 * Returns the recovery codes so a test can exercise the recovery path with real
 * ones rather than fabricating a row.
 */
export async function enrollMfa(client: Client): Promise<{ secret: string; recoveryCodes: string[] }> {
  const start = await client.post("/api/auth/mfa/enroll", {});
  if (start.status >= 400) throw new Error(`mfa enroll failed: ${JSON.stringify(start.json)}`);

  const secret: string = start.json.secret;
  const done = await client.put("/api/auth/mfa/enroll", {
    factorId: start.json.factorId,
    code: totpCode(secret),
  });
  if (done.status >= 400) throw new Error(`mfa confirm failed: ${JSON.stringify(done.json)}`);

  return { secret, recoveryCodes: done.json.recoveryCodes ?? [] };
}

/**
 * A signed-in merchant whose session has **satisfied MFA** (D40).
 *
 * Enrolment happens here rather than in each test because every merchant account
 * needs it now — a session that has not cleared `aal2` is refused by
 * `requireAuthContext`, so without this every file in the suite would fail at
 * its first authenticated request.
 */
export async function signUpMerchant(client: Client, label: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  // Supabase rejects `.test` and `example.com`; markii.shop is a real domain.
  const email = `test-${label}-${stamp}@markii.shop`;
  const password = `Tv!${stamp}aA9`;

  await createConfirmedStaffUser(email, password);

  client.clearCookies();
  const inn = await client.post("/api/auth/sign-in", { email, password });
  if (inn.status >= 400) throw new Error(`sign-in failed: ${JSON.stringify(inn.json)}`);

  const { secret, recoveryCodes } = await enrollMfa(client);

  return { email, password, totpSecret: secret, recoveryCodes };
}

/** Removes a merchant and everything cascading from their org. */
export async function removeMerchant(email: string) {
  const users = await sql`select id from auth.users where email = ${email}`;
  for (const u of users) {
    await sql`delete from organizations where owner_id = ${u.id}`;
    /**
     * **Recovery codes do not cascade** (D40). `mfa_recovery_codes.user_id`
     * points at `auth.users` with deliberately no foreign key — that schema is
     * owned by `supabase_auth_admin`, and coupling the migration chain to it is
     * a bad trade. The consequence is that deleting a user leaves ten rows
     * behind, and since D40 enrols every merchant, the suite was accumulating
     * ten per fixture per run.
     *
     * They are inert once the user is gone — spending a code requires an
     * authenticated session, and there is no longer an account to authenticate
     * as — so this is unbounded growth rather than exposure. Cleaned up here
     * because the suite creates them by the hundred.
     */
    await sql`delete from mfa_recovery_codes where user_id = ${u.id}`;
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
  /**
   * Storefront shoppers (D32) — a **separate identity domain** that owns no org,
   * so nothing above removes them. Tracked here rather than in one test file so
   * the next file that creates a shopper gets cleanup for free; 33 leaked rows
   * accumulated while this lived locally and one fixture forgot to register.
   */
  shopperEmails: string[] = [];
  /** Test-owned stores. Deleting the org cascades everything beneath it. */
  orgIds: string[] = [];
  siteIds: number[] = [];

  async run() {
    /**
     * **Every step runs even if an earlier one fails.**
     *
     * This used to abort on the first error, which is how test users
     * accumulated: a foreign-key complaint partway through left everything
     * after it undone, silently, on exactly the runs where cleanup mattered
     * most. Failures are collected and rethrown at the end, so nothing is
     * hidden and nothing is skipped.
     */
    const failures: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    for (const id of this.usageRecordIds) {
      await attempt("usage record", () => sql`delete from usage_records where id = ${id}`);
    }
    for (const id of this.checkoutSessionIds) {
      await attempt("checkout session", () => sql`delete from checkout_sessions where id = ${id}`);
    }
    for (const id of this.orderIds) {
      await attempt("order", () => sql`delete from orders where id = ${id}`);
    }
    for (const id of this.cartIds) {
      await attempt("cart", () => sql`delete from carts where id = ${id}`);
    }
    for (const id of this.discountIds) {
      await attempt("discount", () => sql`delete from discounts where id = ${id}`);
    }
    for (const id of this.shippingZoneIds) {
      await attempt("shipping zone", () => sql`delete from shipping_zones where id = ${id}`);
    }
    for (const id of this.variantIds) {
      await attempt("ledger", () => sql`delete from inventory_ledger where variant_id = ${id}`);
      await attempt("variant", () => sql`delete from variants where id = ${id}`);
    }
    for (const id of this.locationIds) {
      await attempt("location", () => sql`delete from locations where id = ${id}`);
    }

    /**
     * The safety net, and the reason it is not just belt-and-braces: orders and
     * usage records reference a site with `on delete set null`, so dropping the
     * org would leave them behind pointing at nothing. Sweeping by site catches
     * anything an individual test forgot to track, which is the failure mode
     * that actually happened while writing these.
     */
    for (const id of this.siteIds) {
      await attempt("site usage", () => sql`delete from usage_records where site_id = ${id}`);
      await attempt("site orders", () => sql`delete from orders where site_id = ${id}`);
    }

    // Cascades to sites, products, carts, discounts, zones, tax settings.
    for (const id of this.orgIds) {
      await attempt("org", () => sql`delete from organizations where id = ${id}`);
    }

    for (const email of this.merchantEmails) {
      await attempt("merchant", () => removeMerchant(email));
    }

    /**
     * Shoppers last: sites (and the customer rows beneath them) are gone by now,
     * so nothing still points at the auth row being removed.
     */
    for (const email of this.shopperEmails) {
      await attempt("shopper", () => sql`delete from auth.users where email = ${email}`);
    }

    if (failures.length > 0) {
      throw new Error(
        `cleanup completed with ${failures.length} failure(s): ${failures.join(" | ")}`,
      );
    }
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
