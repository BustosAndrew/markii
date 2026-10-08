import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Abuse and quota controls (G12, G5) — the wiring, which is all that is left
 * once the arithmetic is unit-tested (`lib/email/sending-cap.test.ts`,
 * `lib/storefront/fair-use.test.ts`, `lib/commerce/media-usage.test.ts`).
 *
 * Each control is driven to its limit by **writing the counter directly**
 * rather than by sending 240 requests or 100 emails: what is under test is that
 * the real request reads the real counter and refuses, not that a loop can
 * count. Every refusal test first shows the same request succeeding, or a
 * refusal would pass for any reason at all (`tests/README.md`).
 *
 * The per-link download throttle lives in `delivery.test.ts`, beside the
 * purchase flow that produces a link.
 */

/** TEST-NET-2, varied per run so two runs never share a counter. */
const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

describe("storefront fair use (G12)", () => {
  const cleanup = new Cleanup();
  let slug: string;

  const counter = async (key: string) =>
    Number((await sql`select count from rate_limit_counters where key = ${key}`)[0]?.count ?? 0);

  /**
   * The proxy writes the count in the background (`waitUntil`), so it can land
   * just after the response. Polled until it reaches `expected` or time runs
   * out; the assertion then reads the settled value, too high or too low.
   */
  const settledCounter = async (key: string, expected: number) => {
    let value = await counter(key);
    for (let i = 0; i < 20 && value < expected; i++) {
      await new Promise((r) => setTimeout(r, 250));
      value = await counter(key);
    }
    // Long enough for a second, double-counting write to have landed too.
    await new Promise((r) => setTimeout(r, 500));
    return counter(key);
  };

  beforeAll(async () => {
    ({ slug } = await createTestStore(cleanup, "fairuse"));
  });

  afterAll(async () => {
    await sql`delete from rate_limit_counters where key like ${`sf:${slug}:%`}`;
    await cleanup.run();
  });

  it("counts a request addressed by path, once", async () => {
    const key = `sf:${slug}:${ip}`;
    const before = await counter(key);

    const res = await fetch(`${BASE_URL}/_sites/${slug}/llms.txt`, {
      headers: { "x-forwarded-for": ip },
    });
    expect(res.status).toBe(200);
    // `_sites` used to be excluded from the proxy matcher, which would leave
    // this at its old value and the throttle trivially stepped around.
    expect(await settledCounter(key, before + 1)).toBe(before + 1);
  });

  /**
   * The rewrite to `/_sites/{slug}` must not pass back through the proxy, or
   * every hostname request would be counted twice and the effective limit
   * halved. Only a real request through the proxy can show that.
   */
  it("counts a request addressed by hostname exactly once", async () => {
    const hostIp = `198.51.100.${(Number(ip.split(".")[3]) % 250) + 2}`;
    const key = `sf:${slug}:${hostIp}`;

    /**
     * `node:http` rather than `fetch`: `fetch` forbids setting `Host`, and
     * `{slug}.localhost` does not resolve on every OS (Windows answers
     * ENOTFOUND). Connecting to the server and naming the store in `Host` is
     * exactly what a browser on a storefront subdomain does.
     */
    const base = new URL(BASE_URL);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: base.hostname,
          port: base.port || 80,
          path: "/llms.txt",
          headers: { host: `${slug}.localhost`, "x-forwarded-for": hostIp },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(await settledCounter(key, 1)).toBe(1);
  });

  it("answers 429 with Retry-After once the budget is spent, and points agents elsewhere", async () => {
    const key = `sf:${slug}:${ip}`;
    /**
     * Spend the budget. The store increments before deciding, so a counter
     * already at the default limit of 240 makes the next request the 241st.
     *
     * **The window has to be written too, not only the count.** The row was
     * created by an earlier test, possibly in an earlier minute; a count of 240
     * on an expired window is reset to 1 by the next request, and this test
     * then polled for a 429 that could never come. It passed alone and failed
     * in the full suite, where timing put the two tests in different minutes.
     * Near a boundary it waits for the next minute, so the window cannot roll
     * between the write and the requests that read it.
     */
    if (Date.now() % 60_000 > 40_000) {
      await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 1_000));
    }
    const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await sql`update rate_limit_counters set count = 240, window_start = ${windowStart}
              where key = ${key}`;

    /**
     * The request that crosses the limit is let through — the count is written
     * after the response and the refusal remembered from it — and the one after
     * is refused from that memory without a database call. Polled because the
     * background write lands a moment after the first response.
     */
    const get = () =>
      fetch(`${BASE_URL}/_sites/${slug}/llms.txt`, { headers: { "x-forwarded-for": ip } });
    const crossing = await get();
    expect(crossing.status).toBe(200);
    await crossing.text();

    let refused = await get();
    for (let i = 0; i < 20 && refused.status !== 429; i++) {
      await refused.text();
      await new Promise((r) => setTimeout(r, 250));
      refused = await get();
    }
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("cache-control")).toContain("no-store");
    expect(await refused.text()).toContain("/llms.txt");
  });

  it("throttles one address on one store, not the store", async () => {
    const other = await fetch(`${BASE_URL}/_sites/${slug}/llms.txt`, {
      headers: { "x-forwarded-for": "198.51.100.254" },
    });
    expect(other.status).toBe(200);
  });
});

describe("merchant sending cap (G12)", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  const buyer = `capped+${Date.now()}@example.com`;
  let orgId: string;
  let orderId: number;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "mailcap");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const { site } = await createTestStore(cleanup, "mailcap", { orgId });
    const [order] = await sql`
      insert into orders (site_id, email, status, provider, currency, amount_cents,
                          subtotal_minor, financial_status)
      values (${site.id}, ${buyer}, 'success', 'x402', 'USD', 1400, 1400, 'paid')
      returning id`;
    orderId = order.id as number;
    cleanup.orderIds.push(orderId);
  }, 180_000);

  afterAll(async () => {
    await sql`delete from email_deliveries where org_id = ${orgId}`.catch(() => {});
    await cleanup.run();
  }, 120_000);

  it("reports a new, unpaid account on the trial cap", async () => {
    const res = await merchant.get("/api/settings/email");
    expect(res.status).toBe(200);
    expect(res.json.sendingLimit.tier).toBe("trial");
    expect(res.json.sendingLimit.dailyLimit).toBe(100);
    expect(res.json.sendingLimit.sentLast24h).toBe(0);
  });

  it("refuses a send once the day's cap has left, and says why on the order", async () => {
    // A day's worth of mail that already left. `sent` needs a message id
    // (`email_deliveries_sent_has_id`), so each gets a fake one.
    await sql`
      insert into email_deliveries (org_id, template, to_email, subject, provider, status,
                                    provider_message_id)
      select ${orgId}, 'order_confirmation', 'seed' || g || '@example.com', 'seed', 'ses', 'sent',
             'seed-' || ${orgId} || '-' || g
      from generate_series(1, 100) g`;

    const settings = await merchant.get("/api/settings/email");
    expect(settings.json.sendingLimit.remaining).toBe(0);

    const res = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    // A post-commit effect, so the row lands just after the response.
    let row: { status: string; provider: string; reason: string | null } | undefined;
    for (let i = 0; i < 20 && !row; i++) {
      [row] = (await sql`
        select status, provider, reason from email_deliveries
        where org_id = ${orgId} and to_email = ${buyer}
        order by created_at desc limit 1`) as unknown as (typeof row)[];
      if (!row) await new Promise((r) => setTimeout(r, 500));
    }

    expect(row, "no delivery was recorded").toBeDefined();
    expect(row!.status).toBe("capped");
    expect(row!.provider).toBe("none");
    expect(row!.reason).toContain("100 of 100");

    // The merchant sees it where they look for it — the order timeline, which
    // the same effect writes a moment after the delivery row.
    let failed: { message: string }[] = [];
    for (let i = 0; i < 20 && failed.length === 0; i++) {
      const order = await merchant.get(`/api/orders/${orderId}`);
      failed = (order.json.timeline ?? []).filter((e: any) => e.type === "email_failed");
      if (failed.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.at(-1)!.message).toContain("sending cap");
  });

  /**
   * The refusal above is only the cap if removing the cap's input removes it.
   * Without this the test would pass for a send refused for any other reason.
   */
  it("lets the next send through once the day's count is back under the cap", async () => {
    await sql`delete from email_deliveries where org_id = ${orgId} and subject = 'seed'`;
    const before = Number(
      (await sql`select count(*)::int c from email_deliveries where org_id = ${orgId}`)[0]!.c,
    );

    const res = await merchant.invoke("orders.resendConfirmation", { orderId });
    expect(res.status).toBe(200);

    let rows: { status: string }[] = [];
    for (let i = 0; i < 20 && rows.length <= before; i++) {
      rows = (await sql`select status from email_deliveries where org_id = ${orgId}
                        order by created_at`) as unknown as { status: string }[];
      if (rows.length <= before) await new Promise((r) => setTimeout(r, 500));
    }
    // Whatever this environment's SES does with it, it was not the cap.
    expect(rows.at(-1)!.status).not.toBe("capped");
  });
});

describe("storage allowance (G5)", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  const assetIds: number[] = [];
  let orgId: string;

  const upload = (name: string) => {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(1024).fill(66)], { type: "application/zip" }), name);
    return merchant.postForm("/api/digital-assets", form);
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "mediaquota");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
  }, 180_000);

  afterAll(async () => {
    for (const id of assetIds) await sql`delete from digital_assets where id = ${id}`;
    await cleanup.run();
  }, 120_000);

  it("reports the plan's allowance and how each half is enforced", async () => {
    const res = await merchant.get("/api/digital-assets");
    expect(res.status).toBe(200);
    // Starter, from lib/plans.ts — the quota was null on this route before.
    expect(res.json.usage.quota).toEqual({
      storageBytes: 10 * 1024 ** 3,
      deliveryBytes: 50 * 1024 ** 3,
    });
    expect(res.json.usage.enforcement).toEqual({ storage: "enforced", delivery: "reported" });
  });

  it("accepts an upload that fits", async () => {
    const res = await upload("fits.zip");
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    assetIds.push(res.json.id);
  });

  it("refuses an upload that would take the org past its allowance", async () => {
    // Fill the allowance to within 512 bytes with a row standing for files
    // already stored. Never touches Storage — only the recorded size is summed.
    const used = Number(
      (await sql`select coalesce(sum(size_bytes), 0)::bigint s from digital_assets
                 where org_id = ${orgId}`)[0]!.s,
    );
    // `size_bytes` is a 32-bit integer, so 10 GB takes several rows.
    const INT_MAX = 2 ** 31 - 1;
    let left = 10 * 1024 ** 3 - used - 512;
    for (let i = 0; left > 0; i++) {
      const size = Math.min(left, INT_MAX);
      const [filler] = await sql`
        insert into digital_assets (org_id, storage_path, file_name, content_type, size_bytes)
        values (${orgId}, ${`${orgId}/quota-filler-${i}`}, 'filler.bin',
                'application/octet-stream', ${size})
        returning id`;
      assetIds.push(filler.id);
      left -= size;
    }

    const res = await upload("too-big.zip");
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json.error.code).toBe("QUOTA_EXCEEDED");
    expect(res.json.error.details.overByBytes).toBe(512);
    expect(res.json.error.details.resolution).toBeTruthy();

    // Nothing was stored for the refused file.
    const named = await sql`select id from digital_assets
                            where org_id = ${orgId} and file_name = 'too-big.zip'`;
    expect(named.length).toBe(0);
  });
});
